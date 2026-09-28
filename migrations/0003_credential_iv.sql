-- AES-GCM needs the initialisation vector alongside the ciphertext. Without it
-- a stored refresh token cannot be decrypted at all, which would have surfaced
-- only at the first real sync rather than in any test.
ALTER TABLE accounts ADD COLUMN credential_iv TEXT;
