import { describe, it, expect } from "vitest";
import { createTransporter } from "../transport/factory";
import { Influx } from "../transport/influx";

describe("createTransporter", () => {
  it("returns an Influx instance for type 'influx' v2", () => {
    const t = createTransporter({
      type: "influx",
      version: 2,
      host: "h",
      org: "o",
      bucket: "b",
      token: "t",
    });
    expect(t).toBeInstanceOf(Influx);
  });

  it("returns an Influx instance for type 'influx' v1", () => {
    const t = createTransporter({
      type: "influx",
      version: 1,
      host: "h",
      database: "db",
    });
    expect(t).toBeInstanceOf(Influx);
  });

  it("throws for an unknown transporter type", () => {
    expect(() => createTransporter({ type: "unknown" } as never)).toThrow('Unknown transporter type: "unknown"');
  });
});
