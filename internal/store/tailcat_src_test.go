package store

import (
	"context"
	"testing"
	"time"
)

// TestStore_ActivitySourcePrefixSortAndLegacyDefault covers SrcPrefix
// filtering (ported with the Tailcat series; adapted from upstream's
// internal/store/sqlite/tailcat_test.go to this fork's store API).
func TestStore_ActivitySourcePrefixSortAndLegacyDefault(t *testing.T) {
	st, err := New("")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()
	for i, source := range []string{"ip:127.0.0.1:10", "tc:nodekey:bbb", "tc:nodekey:aaa", "tc:%_literal"} {
		if _, err := st.InsertActivity(ctx, ActivityLogEntry{Timestamp: time.Unix(int64(i+1), 0), Src: source, Model: "m"}); err != nil {
			t.Fatal(err)
		}
	}
	// #nosec G202 -- test-controlled constant SQL
	if _, err := st.db.ExecContext(ctx, `INSERT INTO activity (ts_created, model_id) VALUES (10, 'legacy')`); err != nil {
		t.Fatal(err)
	}

	page, err := st.ListActivity(ctx, ActivityQuery{ActivityFilter: ActivityFilter{SrcPrefix: "tc:"}, Limit: 10, Page: 1, Sort: "src", Order: "asc"})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 3 || page.Data[0].Src != "tc:%_literal" || page.Data[2].Src != "tc:nodekey:bbb" {
		t.Fatalf("source page = %+v", page)
	}
	literal, err := st.ListActivity(ctx, ActivityQuery{ActivityFilter: ActivityFilter{SrcPrefix: "tc:%_"}, Limit: 10, Page: 1})
	if err != nil || literal.Total != 1 {
		t.Fatalf("literal metacharacter prefix = %+v, %v", literal, err)
	}
	legacy, err := st.ListActivity(ctx, ActivityQuery{ActivityFilter: ActivityFilter{Models: []string{"legacy"}}, Limit: 10, Page: 1})
	if err != nil || len(legacy.Data) != 1 || legacy.Data[0].Src != "" {
		t.Fatalf("legacy source = %+v, %v", legacy, err)
	}
}

// TestStore_ActivityStatsModelFilterCountsInterleavedRows covers the
// model-filtered TotalRequests path (upstream PR #1147): activity ids are
// global across models, so MAX(id) overcounts a filtered model and the
// filtered query must count rows instead.
func TestStore_ActivityStatsModelFilterCountsInterleavedRows(t *testing.T) {
	st, err := New("")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()
	for _, model := range []string{"m1", "m2", "m1", "m2", "m1"} {
		if _, err := st.InsertActivity(ctx, ActivityLogEntry{Model: model}); err != nil {
			t.Fatal(err)
		}
	}
	stats, err := st.ActivityStats(ctx, ActivityStatsQuery{Model: "m1"})
	if err != nil {
		t.Fatal(err)
	}
	if stats.TotalRequests != 3 {
		t.Fatalf("filtered total requests = %d, want 3", stats.TotalRequests)
	}
	all, err := st.ActivityStats(ctx, ActivityStatsQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if all.TotalRequests != 5 {
		t.Fatalf("unfiltered total requests = %d, want 5 (MAX(id) survives pruning)", all.TotalRequests)
	}
}
