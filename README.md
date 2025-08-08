# Pulumi AWS - Private CDN with Image Optimization

This project is a **Pulumi** solution that provisions a **secure AWS CDN** with **on-the-fly image optimization**.  

It delivers images through **CloudFront** and ensures access control via **signed URLs**, while caching optimized results for fast subsequent loads.  

Ideal for use cases where:

- You need **private, controlled access** to HQ images  
- You want **automatic optimization** at request time  
- You still require **access to the original files**  
- Existing solutions (like Vercel Image Optimization) don’t meet performance or caching needs

---

## Why I Built This

In my use case, I had a **large number of HQ images** in a web app.  
Vercel’s optimizer fell short because:

- It couldn’t cache presigned S3 URLs
- Proxying through an authenticated API broke optimization (the optimizer cannot access authenticated API routes)
- Rewriting to a presigned URL didn’t work with Vercel, for some unkown reason every request triggered a fresh optimization causing me to hit the Vercel Image Optimization monthly limit in a few hours.

The fix: move **both CDN and optimization** to AWS and restrict CDN access to authenticated clients.

---

## Architecture Overview

This stack deploys:

1. **S3 Buckets**
   - **Source bucket** – original images
   - **Optimization bucket** – cached optimized images
   - **Log bucket** – CloudFront access logs

2. **Lambda Function**: uses [Sharp](https://sharp.pixelplumbing.com/) to optimize images on demand

3. **CloudFront Distribution**: serves images securely and efficiently

### How It Works

- CloudFront access is **restricted by key pair**, therefore URLs must be signed with your private key.
- **Origin group**:
  1. Check optimization bucket first.
  2. If not found, a failover strategy invokes the Lambda.
  3. Lambda optimizes, stores result in optimization bucket, and returns it.
- Only the query parameters `width` and `quality` are allowed.
- Prefixing an object key with `original/` skips optimization and serves the original file.

The **optimization bucket key format** will look like `{width}x{quality}/{original-file-key}`, but you can be unaware of this as all the redirections are handled internally by the lambda and the cloudfront functions.

---

## Example Usage

Let's suppose source bucket contains:

- `image1.jpg`
- `image2.jpg`

You can install `@aws-sdk/cloudfront-signer` to generate signed URLs for CloudFront:

```bash
pnpm install @aws-sdk/cloudfront-signer
```

And sign them with some code that will look like this:

```ts
import { getSignedUrl } from "@aws-sdk/cloudfront-signer";

function sign(objectKey: string) {
  const distributionUrl = "https://your-cloudfront-id.cloudfront.net";
  const keyPairId = "your-key-pair-id";
  const durationSeconds = 30;

  const signedUrl = getSignedUrl({
    url: `${distributionUrl}/${objectKey}`,
    keyPairId,
    dateLessThan: new Date(Date.now() + durationSeconds * 1000),
    privateKey: fs.readFileSync(".keys/private_key.pem", "utf8"),
  });
}

sign("image1.jpg?width=800&q=80"); // Optimize with w=800, q=80
sign("image1.jpg"); // Optimized with default parameters
sign("original/image2.jpg"); // Original image
```

**Note**: You can encode the private key in base64 by running `base64 < .keys/public_key.pem` and then set the private key as an environment variable. This is useful when you want to use the private key in serverless functions or environments where you cannot access the file system directly. Remember to decode it before using it to sign URLs.

## Setup & Deployment

### 1. Generate Key Pair

CloudFront needs a key pair to sign/verify URLs. Use this script to generate a key pair in a gitignored `.keys/` directory:

```bash
sh gen-keys.sh
```

You then have to configure your Pulumi stack with the public key:

```bash
pulumi config set publicKeyEncoded $(base64 < .keys/public_key.pem)
```

---

### 2. Bundle the Optimization Lambda

Sharp requires native dependencies, so we build the lambda with Docker:

```bash
sh ./optimization/bundle.sh
```

---

### 3. Deploy

```bash
pulumi up
```

> **Note:** CloudFront deployments can take **10–15 minutes**.

---

## Testing

You can use a convenience script I made to sign a url:

```bash
pnpm sign-url
```

You’ll be prompted for:

- Private key path (you can use `.keys/private_key.pem`)
- Key pair ID
- CloudFront distribution URL
- Object key
- URL expiration time

---

## Next.js Integration

To replace Vercel’s optimizer:

1. **Create an API route** to sign CloudFront URLs. This route should also check for user authentication or have some kind of restrictions to ensure that only authorized users can access the images.
2. **Write a custom image loader** that fetches signed URLs from the API
3. **Disable built-in optimization** in `next.config.js`:

```js
module.exports = {
  images: {
    unoptimized: true,
  },
};
```

---

## Considerations

- **Signed URLs aren’t cache-friendly**, because each one is unique.  
  Workaround: proxy or rewrite requests through your API.
- **`@aws-sdk/cloudfront-signer` uses Node crypto**, which is not available in edge runtimes (like Vercel middleware). Sign URLs in **server components or API routes**.
- **First requests are a bit slower** since optimization happens on demand. Subsequent requests are fast thanks to caching.

---

## Contributing

This started because there was no good Pulumi-based example for this use case.
If you can improve it, whether it’s optimizations, better security, or more flexibility, please submit a PR so others can benefit. I really hope this helps someone else avoid the pain I went through!

