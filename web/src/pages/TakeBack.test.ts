import { describe, expect, it } from "vitest";
import { envelopeLinkTarget } from "./TakeBack";

const ORIGIN = "https://zenvelope.netlify.app";
const SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

describe("envelopeLinkTarget", () => {
  it("accepts an envelope link on this site", () => {
    const r = envelopeLinkTarget(`  ${ORIGIN}/e#${SECRET}.3490437 `, ORIGIN);
    expect(r).toEqual({ ok: true, url: `${ORIGIN}/e#${SECRET}.3490437` });
  });

  it("refuses another host, a look-alike, or another scheme", () => {
    for (const bad of [
      `https://zenvelope.netlify.app.evil.example/e#${SECRET}`,
      `https://zenve1ope.netlify.app/e#${SECRET}`,
      `http://zenvelope.netlify.app/e#${SECRET}`,
      `javascript:alert(1)`,
      "not a link",
    ]) {
      expect(envelopeLinkTarget(bad, ORIGIN)).toEqual({ ok: false, reason: "notHere" });
    }
  });

  it("refuses a page that is not the open page", () => {
    expect(envelopeLinkTarget(`${ORIGIN}/how#${SECRET}`, ORIGIN)).toEqual({
      ok: false,
      reason: "notHere",
    });
  });

  it("says so when the link has no envelope in it", () => {
    expect(envelopeLinkTarget(`${ORIGIN}/e`, ORIGIN)).toEqual({ ok: false, reason: "noSecret" });
    expect(envelopeLinkTarget(`${ORIGIN}/e#`, ORIGIN)).toEqual({ ok: false, reason: "noSecret" });
  });
});
