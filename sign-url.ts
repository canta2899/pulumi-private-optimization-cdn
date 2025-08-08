import * as fs from "fs";
import * as path from "path";
import inquirer from "inquirer";
import { getSignedUrl } from "@aws-sdk/cloudfront-signer";

function ensureHttpsDomain(domain: string) {
  let d = domain.trim();
  if (!/^https?:\/\//i.test(d)) d = "https://" + d;
  return d.replace(/\/+$/, "");
}

function assert(condition: boolean, msg: string | undefined) {
  if (!condition) throw new Error(msg);
}

(async () => {
  try {
    const answers = await inquirer.prompt([
      {
        type: "input",
        name: "privateKeyPath",
        message: "Path to private key file (PEM for CloudFront key pair):",
        validate: (v) => (v && fs.existsSync(v) ? true : "File not found"),
        filter: (v) => path.resolve(v),
      },
      {
        type: "input",
        name: "keyPairId",
        message: "Key Pair ID:",
        validate: (v) => (!!v ? true : "Required"),
      },
      {
        type: "input",
        name: "cfDomain",
        message:
          "CloudFront distribution domain (e.g. dxxxx.cloudfront.net or https://cdn.example.com):",
        validate: (v) => (!!v ? true : "Required"),
      },
      {
        type: "input",
        name: "objectKey",
        message: "Object key (e.g. folder/file.jpg):",
        validate: (v) => (!!v ? true : "Required"),
      },
      {
        type: "number",
        name: "durationSeconds",
        message: "URL duration in seconds:",
        default: 300,
        validate: (v) =>
          v && Number.isFinite(v) && v > 0 ? true : "Enter a positive number",
        filter: (v) => Number(v),
      },
    ]);

    const privateKey = fs.readFileSync(answers.privateKeyPath, "utf-8");
    assert(
      /BEGIN (RSA )?PRIVATE KEY/.test(privateKey),
      "File doesn't look like a PEM private key"
    );

    const url =
      ensureHttpsDomain(answers.cfDomain) + "/" + answers.objectKey.replace(/^\/+/, "");

    const dateLessThan = new Date(Date.now() + answers.durationSeconds * 1000);

    const signedUrl = getSignedUrl({
      url,
      keyPairId: answers.keyPairId,
      dateLessThan,
      privateKey,
    });

    console.log("\nSigned URL:\n" + signedUrl + "\n");
  } catch (err) {
    if (err instanceof Error) {
      console.error("Error:", err.message);
    } else if (typeof err === "string") {
      console.error("Error:", err);
    } else {
      console.error("Unknown error:", err);
    }
  }
})();
