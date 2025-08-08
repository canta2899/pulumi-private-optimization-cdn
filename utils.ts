import * as pulumi from "@pulumi/pulumi";

export function oacBucketPolicy(
  bucketName: pulumi.Input<string>,
  distId: pulumi.Input<string>,
  accountId: pulumi.Input<string>
) {
  return pulumi
    .all([bucketName, distId, accountId])
    .apply(([bucket, distId, accountId]) =>
      JSON.stringify({
        Version: "2008-10-17",
        Id: "PolicyForCloudFrontPrivateContent",
        Statement: [
          {
            Sid: "AllowCloudFrontServicePrincipal",
            Effect: "Allow",
            Principal: {
              Service: "cloudfront.amazonaws.com",
            },
            Action: "s3:GetObject",
            Resource: `arn:aws:s3:::${bucket}/*`,
            Condition: {
              StringEquals: {
                "AWS:SourceArn": `arn:aws:cloudfront::${accountId}:distribution/${distId}`,
              },
            },
          },
        ],
      })
    );
}

