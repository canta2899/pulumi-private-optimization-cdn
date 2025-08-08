import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { oacBucketPolicy } from "./utils";

const cfg = new pulumi.Config();
const publicKeyBase64 = cfg.get("publicKeyEncoded");

if (!publicKeyBase64) {
  throw new Error("Missing publicKeyEncoded configuration value");
}

const publicKeyPem = Buffer.from(publicKeyBase64, "base64").toString("utf8");

const logBucket = new aws.s3.Bucket("cdn-log-bucket", {
  forceDestroy: true,
});

new aws.s3.BucketOwnershipControls("logOwnership", {
  bucket: logBucket.id,
  rule: {
    objectOwnership: "ObjectWriter",
  },
});

new aws.s3.BucketAcl("logAcl", {
  bucket: logBucket.id,
  acl: "log-delivery-write",
});

new aws.s3.BucketLifecycleConfiguration("logLifecycle", {
  bucket: logBucket.id,
  rules: [
    {
      id: "expire-old-logs",
      status: "Enabled",
      filter: {
        prefix: "logs/",
      },
      expiration: {
        days: 30,
      },
    },
  ],
});

const source = new aws.s3.Bucket("source-images", {})

const optimized = new aws.s3.Bucket("optimized-images", {});

new aws.s3.BucketPublicAccessBlock("optimizedAccessBlock", {
  bucket: optimized.bucket,
  blockPublicAcls: true,
  ignorePublicAcls: true,
  blockPublicPolicy: false,
  restrictPublicBuckets: true,
});

new aws.s3.BucketPublicAccessBlock("sourceAccessBlock", {
  bucket: source.bucket,
  blockPublicAcls: true,
  ignorePublicAcls: true,
  blockPublicPolicy: false,
  restrictPublicBuckets: true,
});

const oac = new aws.cloudfront.OriginAccessControl("oac", {
  name: "cdn-origin-access-control",
  description: "OAC for optimized bucket access",
  originAccessControlOriginType: "s3",
  signingBehavior: "always",
  signingProtocol: "sigv4",
});

const role = new aws.iam.Role("lambdaRole", {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: "lambda.amazonaws.com",
  }),
});

new aws.iam.RolePolicyAttachment("basicExec", {
  role: role.name,
  policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
});

new aws.iam.RolePolicy("s3Access", {
  role: role.name,
  policy: pulumi.all([source.bucket, optimized.bucket]).apply(([src, dst]) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        // allow crud on source and optimized buckets
        {
          Effect: "Allow",
          Action: ["s3:ListBucket"],
          Resource: [`arn:aws:s3:::${src}`],
        },
        {
          Effect: "Allow",
          Action: ["s3:GetObject"],
          Resource: [`arn:aws:s3:::${src}/*`],
        },
        {
          Effect: "Allow",
          Action: ["s3:ListBucket"],
          Resource: [`arn:aws:s3:::${dst}`],
        },
        {
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:PutObject"],
          Resource: [`arn:aws:s3:::${dst}/*`],
        },
      ],
    })
  ),
});

const optimizer = new aws.lambda.Function("imageOptimizer", {
  code: new pulumi.asset.AssetArchive({
    ".": new pulumi.asset.FileArchive("./optimization/lambda"),
  }),
  handler: "index.handler",
  runtime: "nodejs22.x",
  role: role.arn,
  memorySize: 512,
  timeout: 10,
  environment: {
    variables: {
      SOURCE_BUCKET: source.bucket,
      DEST_BUCKET: optimized.bucket,
    },
  },
});

const fnUrl = new aws.lambda.FunctionUrl("optimizerUrl", {
  functionName: optimizer.name,
  authorizationType: "NONE",
});

new aws.lambda.Permission("allowFnUrl", {
  function: optimizer.name,
  action: "lambda:InvokeFunctionUrl",
  principal: "*",
  functionUrlAuthType: "NONE",
});

const publicKey = new aws.cloudfront.PublicKey("publicKey", {
  encodedKey: publicKeyPem,
  comment: "Used for verifying signed URLs",
});

const keyGroup = new aws.cloudfront.KeyGroup("keyGroup", {
  items: [publicKey.id],
  comment: "Key group for CloudFront signed URLs",
});

const cachePolicy = new aws.cloudfront.CachePolicy("customCachePolicy", {
  name: "CustomImageOptimizerPolicy",
  defaultTtl: 31536000,
  maxTtl: 31536000,
  minTtl: 0,
  parametersInCacheKeyAndForwardedToOrigin: {
    queryStringsConfig: {
      queryStringBehavior: "whitelist",
      queryStrings: {
        items: ["width", "quality"],
      },
    },
    cookiesConfig: {
      cookieBehavior: "none",
    },
    headersConfig: {
      headerBehavior: "none",
    },
    enableAcceptEncodingGzip: true,
    enableAcceptEncodingBrotli: true,
  },
});

const originalCachePolicy = new aws.cloudfront.CachePolicy(
  "originalCachePolicy",
  {
    name: "OriginalImageCachePolicy",
    defaultTtl: 31536000,
    maxTtl: 31536000,
    minTtl: 0,
    parametersInCacheKeyAndForwardedToOrigin: {
      queryStringsConfig: { queryStringBehavior: "none" },
      cookiesConfig: { cookieBehavior: "none" },
      headersConfig: { headerBehavior: "none" },
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    },
  }
);

const rewriteFn = new aws.cloudfront.Function("rewriteUri", {
  name: "rewrite-uri-on-viewer-request",
  runtime: "cloudfront-js-1.0",
  publish: true,
  comment: "Rewrite URI based on width and quality",
  code: `
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var qs = request.querystring;

  var width = (qs.width && qs.width.value) ? qs.width.value : "300";
  var quality = (qs.q && qs.q.value) ? qs.q.value : "60";

  var prefix = width + "x" + quality;
  request.uri = "/" + prefix + uri;

  return request;
}
`,
});

const originalRewriteFn = new aws.cloudfront.Function("rewriteOriginal", {
  runtime: "cloudfront-js-1.0",
  comment: "Strip /original prefix",
  publish: true,
  code: `
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.startsWith("/original/")) {
    request.uri = uri.slice("/original".length);
  }
  return request;
}
`,
});

const dist = new aws.cloudfront.Distribution("optimizerCdn", {
  enabled: true,

  origins: [
    {
      originId: "optimizedS3",
      domainName: optimized.bucketRegionalDomainName,
      originAccessControlId: oac.id,
    },
    {
      originId: "sourceS3",
      domainName: source.bucketRegionalDomainName,
      originAccessControlId: oac.id,
    },
    {
      originId: "lambdaOrigin",
      domainName: fnUrl.functionUrl.apply((u) =>
        u.split("://")[1].replace(/\/$/, "")
      ),
      customOriginConfig: {
        originProtocolPolicy: "https-only",
        httpPort: 80,
        httpsPort: 443,
        originSslProtocols: ["TLSv1.2"],
      },
    },
  ],

  originGroups: [
    {
      originId: "groupOptim",
      failoverCriteria: {
        statusCodes: [404, 403],
      },
      members: [{ originId: "optimizedS3" }, { originId: "lambdaOrigin" }],
    },
  ],

  defaultCacheBehavior: {
    targetOriginId: "groupOptim",
    viewerProtocolPolicy: "redirect-to-https",
    allowedMethods: ["GET", "HEAD"],
    cachedMethods: ["GET", "HEAD"],
    compress: true,
    cachePolicyId: cachePolicy.id,
    trustedKeyGroups: [keyGroup.id],
    functionAssociations: [
      {
        eventType: "viewer-request",
        functionArn: rewriteFn.arn,
      },
    ],
  },
  orderedCacheBehaviors: [
    {
      pathPattern: "/original/*",
      targetOriginId: "sourceS3",
      viewerProtocolPolicy: "redirect-to-https",
      allowedMethods: ["GET", "HEAD"],
      cachedMethods: ["GET", "HEAD"],
      compress: true,
      cachePolicyId: originalCachePolicy.id,
      functionAssociations: [
        {
          eventType: "viewer-request",
          functionArn: originalRewriteFn.arn,
        },
      ],
      trustedKeyGroups: [keyGroup.id],
    },
  ],

  loggingConfig: {
    bucket: logBucket.bucketDomainName,
    includeCookies: false,
    prefix: "logs/",
  },

  priceClass: "PriceClass_100",

  viewerCertificate: {
    cloudfrontDefaultCertificate: true,
  },

  restrictions: {
    geoRestriction: {
      restrictionType: "none",
    },
  },
});

const identity = aws.getCallerIdentity({});

new aws.s3.BucketPolicy("optimizedBucketPolicy", {
  bucket: optimized.bucket,
  policy: oacBucketPolicy(
    optimized.bucket,
    dist.id,
    identity.then((i) => i.accountId)
  ),
});

new aws.s3.BucketPolicy("sourceBucketPolicy", {
  bucket: source.bucket,
  policy: oacBucketPolicy(
    source.bucket,
    dist.id,
    identity.then((i) => i.accountId)
  ),
});

export const cdnDomain = dist.domainName;

