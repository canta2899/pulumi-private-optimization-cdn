const {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");
const sharp = require("sharp");

const s3 = new S3Client({ region: process.env.AWS_REGION });
const SRC = process.env.SOURCE_BUCKET;
const DST = process.env.DEST_BUCKET;

exports.handler = async (event) => {
  const path = (event.rawPath || event.path || "").replace(/^\/+/, "");
  const match = path.match(/^(\d+)x(\d+)\/(.+)$/);

  if (!match) {
    return { statusCode: 400, body: "Invalid image path format" };
  }

  const width = parseInt(match[1], 10);
  const quality = parseInt(match[2], 10);
  const key = match[3];
  const dstKey = `${width}x${quality}/${key}`;

  // Check if already optimized
  try {
    await s3.send(new HeadObjectCommand({ Bucket: DST, Key: dstKey }));
    const get = await s3.send(
      new GetObjectCommand({ Bucket: DST, Key: dstKey })
    );
    const buf = await streamToBuffer(get.Body);
    return {
      statusCode: 200,
      isBase64Encoded: true,
      headers: {
        "content-type": get.ContentType || "image/jpeg",
        "cache-control": "max-age=31536000,public",
      },
      body: buf.toString("base64"),
    };
  } catch { }

  // Optimize from source
  try {
    const orig = await s3.send(new GetObjectCommand({ Bucket: SRC, Key: key }));
    const origBuf = await streamToBuffer(orig.Body);

    const outBuf = await sharp(origBuf)
      .resize(width)
      .jpeg({ quality })
      .toBuffer();

    await s3.send(
      new PutObjectCommand({
        Bucket: DST,
        Key: dstKey,
        Body: outBuf,
        ContentType: "image/jpeg",
        CacheControl: "max-age=31536000,public",
      })
    );

    return {
      statusCode: 200,
      isBase64Encoded: true,
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "max-age=31536000,public",
      },
      body: outBuf.toString("base64"),
    };
  } catch (err) {
    console.error("Optimization error:", err);
    return { statusCode: 500, body: "Image optimization failed" };
  }
};

function streamToBuffer(stream) {
  return new Promise((res, rej) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => res(Buffer.concat(chunks)));
    stream.on("error", rej);
  });
}

