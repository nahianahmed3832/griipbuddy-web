import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { hashPassword } from "better-auth/crypto";
import { getDb } from "../src/lib/db/client.ts";
import { requireLocalDatabase } from "../src/lib/db/local.ts";
import { saveIntelligenceDraft, signDraftEvidence } from "../src/lib/intelligence/drafts.ts";
import { marketDay, marketDayStart, shiftCalendarDay } from "../src/lib/market-calendar.ts";

const isolated = process.env.GRIIPBUDDY_ENV_FILE === ".env.test";
const hosted = Boolean(process.env.GRIIPBUDDY_STAGE_URL);
const analyst = "/api/staff/intelligence/analyst";
const windowFor = (timeZone: string) => {
  const now = marketDay(new Date(), timeZone);
  return { from: shiftCalendarDay(now, -6)!, to: shiftCalendarDay(now, -3)!, followUp: shiftCalendarDay(now, -2)! };
};

test.use({ trace: "off" });

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/staff/login");
  const submit = page.getByRole("button", { name: "Sign in to staff dashboard" });
  const staffForm = page.locator("form").filter({ has: submit });
  await staffForm.getByRole("textbox", { name: "Email address" }).fill(email);
  await staffForm.getByLabel("Password", { exact: true }).fill(password);
  await submit.click();
  await page.waitForURL(/\/staff\/?$/);
}

test("staff analyst answers from each selected market and protects its endpoint", async ({ page, baseURL }, info) => {
  test.skip(!isolated && !hosted || !process.env.TEST_OWNER_EMAIL || !process.env.TEST_OWNER_PASSWORD, "Requires dedicated review credentials.");
  test.setTimeout(hosted ? 90_000 : 45_000);
  const origin = new URL(baseURL!).origin;
  const question = "Where are we losing purchases?";
  const bd = windowFor("Asia/Dhaka");
  const data = { marketId: "bd", test: true, from: bd.from, to: bd.to, question };
  const unauthorized = await page.request.post(analyst, { data, headers: { origin } });
  expect(unauthorized.status()).toBe(401);
  await signIn(page, process.env.TEST_OWNER_EMAIL!, process.env.TEST_OWNER_PASSWORD!);
  const wrongOrigin = await page.request.post(analyst, { data, headers: { origin: "https://untrusted.example.test" } });
  expect(wrongOrigin.status()).toBe(403);

  const markets = info.project.name === "narrow-mobile" ? [["us", "United States", "America/New_York"]]
    : [["bd", "Bangladesh", "Asia/Dhaka"], ["us", "United States", "America/New_York"]];
  for (const [id, name, zone] of markets) {
    const period = windowFor(zone);
    await page.goto(`/staff/intelligence?market=${id}&scope=test&view=analyst&from=${period.from}&to=${period.to}`);
    await expect(page.getByRole("heading", { name: "Product Intelligence", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Market", exact: true })).toHaveValue(id);
    const reply = page.waitForResponse(response => new URL(response.url()).pathname === analyst && response.request().method() === "POST");
    await page.getByRole("button", { name: question, exact: true }).click();
    const received = await reply;
    expect(received.status()).toBe(200);
    expect(received.headers()["cache-control"]).toContain("no-store");
    const { answer } = await received.json();
    expect(answer).toMatchObject({ intent: "conversion", marketId: id, test: true, window: { from: period.from, to: period.to } });
    await expect(page.getByRole("heading", { name: "Observed facts" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Hypotheses to investigate" })).toBeVisible();
    await expect(page.getByText(`${name} · ${period.from} – ${period.to} · Staging fixtures and test evidence`, { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Source view", exact: true }).first()).toHaveAttribute("href", new RegExp(`market=${id}.*scope=test`));
    if (answer.connection === "not-configured") await expect(page.getByText("LLM explanation is unconfigured.", { exact: false })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(info.project.use.viewport!.width);
  }
});

test("reporting-only grants protect analyst data and owner follow-up stays in the fixture draft", async ({ page, browser, baseURL }, info) => {
  test.skip(!isolated || info.project.name !== "desktop", "Requires the isolated desktop fixture database.");
  requireLocalDatabase("griipbuddy_test");
  test.setTimeout(55_000);
  const db = getDb();
  const reporterId = randomUUID();
  const reporterEmail = `intelligence-reporting-${reporterId}@example.test`;
  const reporterPassword = randomUUID();
  const suffix = reporterId.slice(0, 8).replace(/\d/g, "x");
  const term = `studio organizer ${suffix}`;
  const title = `Assortment test for “${term}”`;
  const journeys = Array.from({ length: 6 }, () => randomUUID());
  const period = windowFor("Asia/Dhaka");
  const observedAt = new Date(+marketDayStart(period.from, "Asia/Dhaka")! + 3600_000);
  const report = `/staff/intelligence?market=bd&scope=test&from=${period.from}&to=${period.to}`;
  const origin = new URL(baseURL!).origin;
  const reporter = await browser.newContext({ baseURL });
  const created = { test: true, marketId: "bd" as const, evidence: { path: ["title"], equals: title } };

  try {
    const hash = await hashPassword(reporterPassword);
    await db.user.create({ data: { id: reporterId, email: reporterEmail, name: "Intelligence reporting fixture", emailVerified: true,
      staff: { create: { role: "PACKER", marketGrants: { create: { marketId: "bd", reporting: true } } } },
      accounts: { create: { id: randomUUID(), accountId: reporterId, providerId: "credential", password: hash } },
    } });
    await db.measurementJourney.createMany({ data: journeys.map(id => ({ id, test: true, grantedAt: observedAt,
      expiresAt: new Date(+observedAt + 7 * 86_400_000) })) });
    await db.measurementEvent.createMany({ data: journeys.map(journeyId => ({ id: randomUUID(), journeyId,
      kind: "SEARCH", marketId: "bd", sessionId: randomUUID(), at: observedAt, receivedAt: observedAt,
      details: { query: term, resultCount: 0 } })) });

    const restricted = await reporter.newPage();
    await signIn(restricted, reporterEmail, reporterPassword);
    await restricted.goto(report);
    await expect(restricted.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(restricted.getByRole("combobox", { name: "Market", exact: true }).locator("option")).toHaveCount(1);
    await expect(restricted.getByRole("button", { name: "Create draft", exact: true })).toHaveCount(0);
    const permitted = await restricted.request.post(analyst, { headers: { origin }, data: {
      marketId: "bd", test: true, from: period.from, to: period.to, question: "Which searches are we failing to serve?",
    } });
    expect(permitted.status()).toBe(200);
    expect(JSON.stringify(await permitted.json())).toContain(term);
    const deniedApi = await restricted.request.post(analyst, { headers: { origin }, data: {
      marketId: "us", test: true, from: period.from, to: period.to, question: "What demand is growing in this market?",
    } });
    expect(deniedApi.status()).toBe(404);
    for (const unauthorized of ["us", "all"]) {
      await restricted.goto(`/staff/intelligence?market=${unauthorized}&scope=test`);
      await expect(restricted.getByRole("heading", { name: "Product Intelligence", exact: true })).toHaveCount(0);
    }
    const token = signDraftEvidence(reporterId, { sourceId: "restricted-test", marketId: "bd", test: true,
      from: period.from, to: period.to, title, facts: [], hypothesis: "Review a synthetic category.", href: report });
    expect(token).toBeTruthy();
    await expect(saveIntelligenceDraft(reporterId, "PRODUCT_TEST", token)).rejects.toThrow(/unavailable to your account/);

    await signIn(page, process.env.TEST_OWNER_EMAIL!, process.env.TEST_OWNER_PASSWORD!);
    await page.goto(report);
    const opportunity = page.getByRole("article").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
    await opportunity.getByRole("button", { name: "Create draft", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Recommendation history and observed outcomes" })).toBeVisible();
    const saved = page.getByRole("article").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
    await expect(saved.getByText(/Product-test plan/)).toBeVisible();
    await saved.getByText("Record a follow-up observation", { exact: true }).click();
    await saved.getByLabel("Observed from").fill(period.followUp);
    await saved.getByLabel("Observed through").fill(period.followUp);
    await saved.getByLabel("Aggregate evidence note").fill("Synthetic fixture observation for evidence workflow.");
    await saved.getByRole("button", { name: "Save observation" }).click();
    await expect(saved.getByText("Fixture observation saved.", { exact: true })).toBeVisible();
    const row = await db.intelligenceDraft.findFirstOrThrow({ where: created, include: { observations: true } });
    expect(row.kind).toBe("PRODUCT_TEST");
    expect(row.observations).toHaveLength(1);
    expect(row.observations[0].result).toBe("INCONCLUSIVE");
  } finally {
    await reporter.close();
    const saved = await db.intelligenceDraft.findMany({ where: created, select: { id: true } });
    const drafts = saved.map(row => row.id);
    await db.auditEvent.deleteMany({ where: { target: { in: drafts } } });
    await db.intelligenceDraftObservation.deleteMany({ where: { draftId: { in: drafts } } });
    await db.intelligenceDraft.deleteMany({ where: created });
    await db.measurementJourney.deleteMany({ where: { id: { in: journeys } } });
    await db.user.deleteMany({ where: { id: reporterId } });
    await db.$disconnect();
  }
});
