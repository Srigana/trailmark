/**
 * Turns UTM tags and referrer domains into one human readable source label.
 * UTM tags win over the referrer because they are set on purpose by whoever posted the link.
 * The same function labels Google Analytics sources on the comparison page, so both sides
 * of that comparison are grouped by identical rules.
 */

interface Rule {
  label: string;
  /** Matches a utm_source value or a GA source name (lowercase). */
  names: string[];
  /** Matches a referrer hostname or one of its parent domains. */
  domains: string[];
  /** Matches hosts such as google.co.uk or google.de. */
  pattern?: RegExp;
}

const RULES: Rule[] = [
  // Webmail first so mail.google.com is not counted as Google search.
  { label: 'Email', names: ['email', 'newsletter'], domains: ['mail.google.com', 'outlook.live.com'] },
  { label: 'Google', names: ['google', 'google.com'], domains: [], pattern: /(^|\.)google\.[a-z.]{2,8}$/ },
  { label: 'Bing', names: ['bing'], domains: ['bing.com'] },
  { label: 'DuckDuckGo', names: ['duckduckgo', 'ddg'], domains: ['duckduckgo.com'] },
  { label: 'LinkedIn', names: ['linkedin', 'lnkd'], domains: ['linkedin.com', 'lnkd.in'] },
  { label: 'Reddit', names: ['reddit'], domains: ['reddit.com', 'redd.it'] },
  { label: 'Hacker News', names: ['hackernews', 'hacker_news', 'hn', 'ycombinator'], domains: ['news.ycombinator.com'] },
  { label: 'X', names: ['twitter', 'x', 'x.com'], domains: ['t.co', 'twitter.com', 'x.com'] },
  { label: 'Facebook', names: ['facebook', 'fb', 'meta'], domains: ['facebook.com', 'fb.com', 'fb.me'] },
  { label: 'Instagram', names: ['instagram', 'ig'], domains: ['instagram.com'] },
  { label: 'YouTube', names: ['youtube', 'yt'], domains: ['youtube.com', 'youtu.be'] },
  { label: 'GitHub', names: ['github'], domains: ['github.com'] },
  { label: 'Product Hunt', names: ['producthunt', 'product_hunt', 'ph'], domains: ['producthunt.com'] },
  { label: 'ChatGPT', names: ['chatgpt', 'chatgpt.com', 'openai'], domains: ['chatgpt.com', 'chat.openai.com'] },
  { label: 'Perplexity', names: ['perplexity'], domains: ['perplexity.ai'] },
];

export const DIRECT = 'Direct';
export const OTHER = 'Other';

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

function matchDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function byName(value: string): string | null {
  const v = value.trim().toLowerCase();
  for (const rule of RULES) {
    if (rule.names.includes(v)) return rule.label;
  }
  // utm_source is sometimes set to a domain (for example utm_source=reddit.com).
  return byHost(v);
}

function byHost(value: string): string | null {
  const host = normalizeHost(value);
  if (!host) return null;
  for (const rule of RULES) {
    if (rule.domains.some((d) => matchDomain(host, d))) return rule.label;
    if (rule.pattern?.test(host)) return rule.label;
  }
  return null;
}

export interface Attribution {
  utmSource?: string | null;
  utmMedium?: string | null;
  referrerHost?: string | null;
}

export function classifySource(a: Attribution, siteHosts: string[] = []): string {
  if (a.utmSource && a.utmSource.trim()) {
    return byName(a.utmSource) ?? OTHER;
  }
  if (a.utmMedium && a.utmMedium.trim().toLowerCase() === 'email') return 'Email';
  if (a.referrerHost && a.referrerHost.trim()) {
    const host = normalizeHost(a.referrerHost);
    if (siteHosts.some((h) => matchDomain(host, normalizeHost(h)))) return DIRECT;
    return byHost(host) ?? OTHER;
  }
  return DIRECT;
}

/** Labels a Google Analytics source string such as "google", "lnkd.in" or "(direct)". */
export function classifyGaSource(gaSource: string): string {
  const s = gaSource.trim().toLowerCase();
  if (s === '' || s === '(direct)' || s === '(none)') return DIRECT;
  if (s === '(not set)') return '(not set)';
  return byName(s) ?? OTHER;
}

export const KNOWN_SOURCES = [DIRECT, ...RULES.map((r) => r.label), OTHER];
