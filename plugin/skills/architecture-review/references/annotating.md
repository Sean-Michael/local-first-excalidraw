# Annotating findings

Findings sit on the drawing next to what they're about, so the user reads them in context. They are additions only: the user's elements keep their ids, positions, sizes, labels, colours and arrows.

## The note

- A rectangle with `"color": "red"` (red stroke, pale red fill), `"rounded": true`, `"strokeStyle": "dashed"` so it reads as an annotation rather than a component.
- Label: `"HIGH: <short title>\n<failure in one line>\n<fix in one line>"`, at `fontSize` 16. Severity first and in capitals, so the text carries the meaning as well as the colour. Keep each line under ~40 characters.
- Id: `review-<n>-<slug>` (`review-1-pg-spof`). The `review-` prefix lets anyone remove all notes at once.
- An arrow from the note to the element it's about: `"strokeColor": "#e03131"`, `"strokeStyle": "dashed"`, id `review-<n>-arrow`, no label. Arrows bind only to shapes, so for a finding about a call, point at the shape that makes the call and name the call in the note's title.

## Placement

1. Take the target's position and size from `read_drawing`.
2. Put the note in empty space beside the target, outside its frame: above for elements in the top row, below for the bottom row, otherwise to whichever side has room. Leave at least 40 px to everything, and keep the note out of any frame (no `frameId`), so it doesn't resize a boundary.
3. If there's no room near the target, put the note in a column to the right of the whole drawing (`x` = drawing's right edge + 120) and rely on the arrow.
4. Notes must not cover the user's elements or arrows, nor each other. After adding, `render_drawing` and move only `review-*` elements if something overlaps.

## Summary block

One text element at the drawing's top right, `id: "review-summary"`, `fontSize` 18, `strokeColor` `"#e03131"`:

```
Architecture review (<date>)
HIGH 2 · MEDIUM 3 · LOW 1
Notes: review-* (delete to clear)
```

## Example batch

For a drawing where `shopapp-pg` and `courier-worker` are existing shapes:

```json
{
  "elements": [
    { "type": "rectangle", "id": "review-1-pg-spof", "x": 980, "y": 420, "color": "red", "rounded": true, "strokeStyle": "dashed",
      "label": { "text": "HIGH: shopapp-pg is a SPOF\nOne Postgres for auth and orders\nAdd a replica + failover", "fontSize": 16 } },
    { "type": "arrow", "id": "review-1-arrow", "start": { "id": "review-1-pg-spof" }, "end": { "id": "shopapp-pg" },
      "strokeColor": "#e03131", "strokeStyle": "dashed" },
    { "type": "rectangle", "id": "review-2-courier-retry", "x": 1320, "y": 40, "color": "red", "rounded": true, "strokeStyle": "dashed",
      "label": { "text": "HIGH: endless requeue, no DLQ\nPoison message blocks order-events\nBounded retries, DLQ, dedupe", "fontSize": 16 } },
    { "type": "arrow", "id": "review-2-arrow", "start": { "id": "review-2-courier-retry" }, "end": { "id": "courier-worker" },
      "strokeColor": "#e03131", "strokeStyle": "dashed" },
    { "type": "text", "id": "review-summary", "x": 1320, "y": -80, "fontSize": 18, "strokeColor": "#e03131",
      "text": "Architecture review\nHIGH 2 · MEDIUM 0 · LOW 0\nNotes: review-* (delete to clear)" }
  ]
}
```

Send it with `add_elements` (`placement: "absolute"`, `if_rev` from `read_drawing`) after `snapshot_drawing`.

## Clearing or updating

To clear the review: `read_drawing`, collect the ids that start with `review-` (`query` matches labels and text, not ids), then `delete_elements` with them. To re-review after changes, clear first, then annotate again, rather than editing old notes one by one.
