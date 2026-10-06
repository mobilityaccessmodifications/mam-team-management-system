import assert from "node:assert/strict";
import test from "node:test";

async function configuration(contact) {
  const oldOrigin = process.env.MAM_BROWSER_ORIGIN;
  const oldContact = process.env.MAM_CONTACT_ORIGIN;
  process.env.MAM_BROWSER_ORIGIN = "http://127.0.0.1:12345";
  if (contact) process.env.MAM_CONTACT_ORIGIN = process.env.MAM_BROWSER_ORIGIN;
  else delete process.env.MAM_CONTACT_ORIGIN;
  try {
    const url = new URL(`./browser/playwright.config.mjs?fixture=${contact ? "contact" : "staff"}`, import.meta.url);
    return (await import(url.href)).default;
  } finally {
    if (oldOrigin === undefined) delete process.env.MAM_BROWSER_ORIGIN;
    else process.env.MAM_BROWSER_ORIGIN = oldOrigin;
    if (oldContact === undefined) delete process.env.MAM_CONTACT_ORIGIN;
    else process.env.MAM_CONTACT_ORIGIN = oldContact;
  }
}

test("staff component browser fixture retains the existing behavior and calendar specs", async () => {
  assert.equal((await configuration(false)).testMatch, "**/*.spec.mjs");
});

test("dedicated contact browser fixture cannot select staff-calendar specs", async () => {
  assert.equal((await configuration(true)).testMatch, "**/contact-lifetime.spec.mjs");
});
