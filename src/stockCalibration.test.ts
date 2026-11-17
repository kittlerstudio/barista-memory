import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db/db.js";
import { createCoffee } from "./coffees.js";
import { recordSetup } from "./setups.js";
import { calibrateStock, currentStock } from "./coffeeStats.js";

test("a weighing replaces bag weight minus doses; later doses still count down from it", () => {
  const dir = mkdtempSync(join(tmpdir(), "bm-stock-cal-"));
  const db = openDatabase(join(dir, "archive.db"));
  const now = Math.floor(Date.now() / 1000);

  const coffee = createCoffee(db, { name: "Uganda Zebigi", roaster: "Father's", bag_g: 250 });
  recordSetup(db, { coffee_id: coffee.id, roast_date: "2026-11-01", dose_g: 18, valid_from: now - 3 * 86400 });
  const shot = db.prepare("INSERT INTO shots (id, device_id, started_at, ingested_at, kind) VALUES (?, ?, ?, 0, 'shot')");
  for (let i = 0; i < 5; i++) shot.run(i + 1, i + 1, now - 2 * 86400 + i * 3600);

  // Five doses of 18 g from a 250 g bag.
  assert.equal(currentStock(db)!.remaining_g, 160);
  assert.equal(currentStock(db)!.calibrated_at, null);

  // Purges and retention: the scale says less is left.
  const stock = calibrateStock(db, 131.37, now - 86400);
  assert.equal(stock.remaining_g, 131.4);
  assert.equal(stock.calibrated_at, now - 86400);

  // A coffee after the weighing counts down from it.
  shot.run(6, 6, now - 3600);
  assert.equal(currentStock(db)!.remaining_g, 113.4);

  // The newest weighing wins.
  calibrateStock(db, 100, now - 60);
  assert.equal(currentStock(db)!.remaining_g, 100);

  // Another bag (a new roast date) starts from its bag weight again.
  recordSetup(db, { roast_date: "2026-11-15", valid_from: now });
  assert.equal(currentStock(db)!.remaining_g, 250);

  assert.throws(() => calibrateStock(db, -1));
  assert.throws(() => calibrateStock(db, Number.NaN));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
