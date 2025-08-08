#!/bin/sh

echo "Generating RSA private and public keys..."

mkdir -p ".keys"

openssl genrsa -out .keys/private_key.pem 2048
openssl rsa -pubout -in .keys/private_key.pem -out .keys/public_key.pem

echo "Keys generated successfully. The private key is stored in .keys/private_key.pem and the public key in .keys/public_key.pem."
