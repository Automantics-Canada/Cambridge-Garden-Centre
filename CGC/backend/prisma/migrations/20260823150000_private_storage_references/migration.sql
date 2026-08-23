-- Replace durable public Supabase URLs with opaque in-bucket references.
-- The application turns these into short-lived, HMAC-signed backend links at
-- response time and reads the private bucket with the backend service role.
-- Local `/uploads/...` QA fixtures and unrelated external URLs are untouched.

UPDATE "Ticket"
SET "imageUrl" = 'storage://' || regexp_replace(
  split_part("imageUrl", '?', 1),
  '^.*/storage/v1/object/public/',
  ''
)
WHERE "imageUrl" LIKE '%/storage/v1/object/public/%';

UPDATE "Ticket"
SET "thumbnailUrl" = 'storage://' || regexp_replace(
  split_part("thumbnailUrl", '?', 1),
  '^.*/storage/v1/object/public/',
  ''
)
WHERE "thumbnailUrl" LIKE '%/storage/v1/object/public/%';

UPDATE "Invoice"
SET "fileUrl" = 'storage://' || regexp_replace(
  split_part("fileUrl", '?', 1),
  '^.*/storage/v1/object/public/',
  ''
)
WHERE "fileUrl" LIKE '%/storage/v1/object/public/%';

UPDATE "Delivery"
SET "pickupPhotoUrl" = 'storage://' || regexp_replace(
  split_part("pickupPhotoUrl", '?', 1),
  '^.*/storage/v1/object/public/',
  ''
)
WHERE "pickupPhotoUrl" LIKE '%/storage/v1/object/public/%';

UPDATE "Delivery"
SET "deliveryPhotoUrl" = 'storage://' || regexp_replace(
  split_part("deliveryPhotoUrl", '?', 1),
  '^.*/storage/v1/object/public/',
  ''
)
WHERE "deliveryPhotoUrl" LIKE '%/storage/v1/object/public/%';
