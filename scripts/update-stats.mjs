// Rewrites the commit stats in profile/README.md from the org's repositories.
// Counts unique commits across every branch, since some repos work off main.
import { readFile, writeFile } from "node:fs/promises";

const ORG = process.env.ORG ?? "PSEMS-CO-FOE";
const TOKEN = process.env.GH_TOKEN;
const README = process.env.README_PATH ?? "profile/README.md";
const EXCLUDE = new Set([".github", ".github-private"]);
const CHART_MONTHS = 12;

if (!TOKEN) throw new Error("GH_TOKEN is not set");

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (res.status === 409) return []; // empty repository
  if (!res.ok) throw new Error(`${res.status} ${path}: ${await res.text()}`);
  return res.json();
}

async function paginate(path) {
  const items = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = await gh(`${path}${sep}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

async function repoStats(repo) {
  const branches = await paginate(`/repos/${ORG}/${repo.name}/branches`);
  const commits = new Map();
  for (const branch of branches) {
    const sha = encodeURIComponent(branch.commit.sha);
    for (const c of await paginate(`/repos/${ORG}/${repo.name}/commits?sha=${sha}`)) {
      commits.set(c.sha, c.commit.author.date);
    }
  }
  const dates = [...commits.values()].sort();
  return { name: repo.name, branches: branches.length, dates, last: dates.at(-1) };
}

const monthKey = (iso) => iso.slice(0, 7);
const monthLabel = (key) => {
  const [y, m] = key.split("-").map(Number);
  const name = new Date(Date.UTC(y, m - 1)).toLocaleString("en", { month: "short", timeZone: "UTC" });
  return `${name} ${String(y).slice(2)}`;
};

function chartMonths(firstIso) {
  const now = new Date();
  const keys = [];
  for (let i = CHART_MONTHS - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i));
    keys.push(d.toISOString().slice(0, 7));
  }
  return keys.filter((k) => k >= monthKey(firstIso));
}

function render(stats) {
  const all = stats.flatMap((s) => s.dates).sort();
  const total = all.length;
  const rows = stats
    .sort((a, b) => b.dates.length - a.dates.length)
    .map((s) => `| \`${s.name}\` | ${s.dates.length} | ${s.branches} | ${s.last?.slice(0, 10) ?? "—"} |`);

  const months = chartMonths(all[0]);
  const perMonth = months.map((k) => all.filter((d) => monthKey(d) === k).length);

  return [
    "| Repository | Commits | Branches | Last commit |",
    "|---|---:|---:|---|",
    ...rows,
    `| **Total** | **${total}** | | |`,
    "",
    "```mermaid",
    "xychart-beta",
    '    title "Commits per month"',
    `    x-axis [${months.map((k) => `"${monthLabel(k)}"`).join(", ")}]`,
    '    y-axis "Commits"',
    `    bar [${perMonth.join(", ")}]`,
    "```",
    "",
    `<sub>Since ${all[0].slice(0, 10)} · updated automatically</sub>`,
  ].join("\n");
}

function replaceBetween(text, tag, content) {
  const re = new RegExp(`(<!-- ${tag}:start -->)[\\s\\S]*?(<!-- ${tag}:end -->)`);
  if (!re.test(text)) throw new Error(`Markers for "${tag}" not found in ${README}`);
  return text.replace(re, `$1${content}$2`);
}

const repos = (await paginate(`/orgs/${ORG}/repos?type=all`)).filter(
  (r) => !r.archived && !r.fork && !EXCLUDE.has(r.name),
);
const stats = await Promise.all(repos.map(repoStats));
const total = stats.reduce((n, s) => n + s.dates.length, 0);

let readme = await readFile(README, "utf8");
readme = replaceBetween(readme, "commit-total", String(total));
readme = replaceBetween(readme, "commit-stats", `\n${render(stats)}\n`);
await writeFile(README, readme);

console.log(`${repos.length} repositories, ${total} commits`);
