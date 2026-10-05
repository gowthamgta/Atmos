"""Upload encoded fields to an S3-compatible bucket (Backblaze B2) and prune old runs."""
from __future__ import annotations
import json, os
import boto3

IMMUTABLE = "public, max-age=31536000, immutable"


def client():
    endpoint = os.environ["B2_ENDPOINT"].strip()
    if not endpoint.startswith("http"):
        endpoint = "https://" + endpoint
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=os.environ["B2_KEY_ID"],
        aws_secret_access_key=os.environ["B2_APP_KEY"],
    )


def current_run(s3, bucket: str, model: str) -> str | None:
    try:
        body = s3.get_object(Bucket=bucket, Key=f"{model}/latest.json")["Body"].read()
        return json.loads(body)["run"]
    except s3.exceptions.NoSuchKey:
        return None


def put(s3, bucket: str, key: str, body: bytes, content_type: str, cache: str) -> None:
    s3.put_object(Bucket=bucket, Key=key, Body=body, ContentType=content_type, CacheControl=cache)


def prune(s3, bucket: str, model: str, keep: list[str]) -> list[str]:
    """Delete run folders not in `keep`; returns the deleted run ids."""
    resp = s3.list_objects_v2(Bucket=bucket, Prefix=f"{model}/", Delimiter="/")
    runs = [p["Prefix"].split("/")[1] for p in resp.get("CommonPrefixes", [])]
    deleted = []
    for run in runs:
        if run in keep:
            continue
        pager = s3.get_paginator("list_objects_v2")
        for page in pager.paginate(Bucket=bucket, Prefix=f"{model}/{run}/"):
            objs = [{"Key": o["Key"]} for o in page.get("Contents", [])]
            if objs:
                s3.delete_objects(Bucket=bucket, Delete={"Objects": objs})
        deleted.append(run)
    return deleted
