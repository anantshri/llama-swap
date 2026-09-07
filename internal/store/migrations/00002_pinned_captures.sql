-- +goose Up
CREATE TABLE pinned_captures (
    activity_id INTEGER PRIMARY KEY,
    ts_pinned   INTEGER NOT NULL,
    model_id    TEXT NOT NULL DEFAULT '',
    req_path    TEXT NOT NULL DEFAULT '',
    data        BLOB NOT NULL
);

-- +goose Down
DROP TABLE pinned_captures;
