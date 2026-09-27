-- +goose Up
ALTER TABLE activity ADD COLUMN src TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE activity DROP COLUMN src;
