/**
 * references.ts
 *
 * Academic citation search & BibTeX generation — 100% client-side.
 *
 * Two public scholarly metadata APIs are queried straight from the browser
 * (both send permissive CORS headers, so no proxy is needed):
 * - OpenAlex: https://api.openalex.org/works?search=<q>&per_page=10
 * - Crossref: https://api.crossref.org/works?query.bibliographic=<q>&rows=10
 *
 * Their responses are normalized into one `AcademicPaper` shape, and
 * `paperToBibTeX()` turns that shape into a ready-to-append `.bib` entry.
 * The BibTeX string is built purely from the normalized JSON metadata — we
 * never follow `doi.org` redirects (they would fail CORS in the browser).
 */

/** Unified representation of a scholarly work, regardless of API source. */
export interface AcademicPaper {
  /** Stable source id (OpenAlex work URL or Crossref DOI). */
  id: string;
  title: string;
  /** Author display names in publication order ("Donald E. Knuth"). */
  authors: string[];
  /** Publication year, or 0 when unknown. */
  year: number;
  /** Bare DOI ("10.1000/xyz.123"), when available. */
  doi?: string;
  /** Journal / proceedings / repository name. */
  venue?: string;
  /** Plain-text abstract (truncated), when available. */
  abstract?: string;
}

/** Available metadata providers. */
export type SearchSource = 'openalex' | 'crossref';

const MAX_ABSTRACT_CHARS = 500;

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function fetchJson(url: string, label: string, signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new Error(`${label} search failed — check your network connection.`);
  }
  if (!res.ok) throw new Error(`${label} search failed (HTTP ${res.status}).`);
  return res.json();
}

// ---------------------------------------------------------------------------
// OpenAlex
// ---------------------------------------------------------------------------

/** The subset of an OpenAlex work record we consume. */
interface OpenAlexWork {
  id?: string;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  doi?: string | null;
  authorships?: { author?: { display_name?: string | null } | null }[] | null;
  primary_location?: { source?: { display_name?: string | null } | null } | null;
  abstract_inverted_index?: Record<string, number[]> | null;
}

/**
 * OpenAlex ships abstracts as an inverted index ({ word → positions }).
 * Rebuild the original sentence order by placing each word at its offsets.
 */
function abstractFromInvertedIndex(index: Record<string, number[]>): string {
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words[position] = word;
  }
  return words.join(' ');
}

/** "https://doi.org/10.1000/xyz.123" → "10.1000/xyz.123" (OpenAlex style). */
function bareDoi(doi: string | null | undefined): string | undefined {
  if (!doi) return undefined;
  return doi.replace(/^https?:\/\/doi\.org\//i, '').trim() || undefined;
}

export async function searchOpenAlex(query: string, signal?: AbortSignal): Promise<AcademicPaper[]> {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=10`;
  const json = (await fetchJson(url, 'OpenAlex', signal)) as { results?: OpenAlexWork[] };

  return (json.results ?? []).map((work) => ({
    id: work.id ?? `openalex-${work.title ?? 'untitled'}`,
    title: (work.display_name ?? work.title ?? 'Untitled').trim(),
    authors: (work.authorships ?? [])
      .map((a) => a.author?.display_name?.trim())
      .filter((name): name is string => Boolean(name)),
    year: work.publication_year ?? 0,
    doi: bareDoi(work.doi),
    venue: work.primary_location?.source?.display_name ?? undefined,
    abstract: work.abstract_inverted_index
      ? truncate(abstractFromInvertedIndex(work.abstract_inverted_index))
      : undefined,
  }));
}

// ---------------------------------------------------------------------------
// Crossref
// ---------------------------------------------------------------------------

/** The subset of a Crossref work record we consume. */
interface CrossrefWork {
  DOI?: string;
  title?: string[];
  author?: { given?: string; family?: string; name?: string }[] | null;
  issued?: { 'date-parts'?: number[][] } | null;
  'container-title'?: string[];
  abstract?: string | null;
}

/** Crossref wraps abstracts in JATS XML (<jats:p>…) — strip to plain text. */
function stripJats(abstract: string): string {
  return truncate(
    abstract
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

export async function searchCrossref(query: string, signal?: AbortSignal): Promise<AcademicPaper[]> {
  const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=10`;
  const json = (await fetchJson(url, 'Crossref', signal)) as { message?: { items?: CrossrefWork[] } };

  return (json.message?.items ?? []).map((work) => ({
    id: work.DOI ?? `crossref-${work.title?.[0] ?? 'untitled'}`,
    title: (work.title?.[0] ?? 'Untitled').trim(),
    authors: (work.author ?? [])
      .map((a) => (a.name ?? [a.given, a.family].filter(Boolean).join(' ')).trim())
      .filter((name): name is string => Boolean(name)),
    year: work.issued?.['date-parts']?.[0]?.[0] ?? 0,
    doi: bareDoi(work.DOI),
    venue: work['container-title']?.[0] ?? undefined,
    abstract: work.abstract ? stripJats(work.abstract) : undefined,
  }));
}

// ---------------------------------------------------------------------------
// Unified search entry point
// ---------------------------------------------------------------------------

/** Search the given provider for scholarly works matching `query`. */
export async function searchPapers(
  query: string,
  source: SearchSource,
  signal?: AbortSignal,
): Promise<AcademicPaper[]> {
  return source === 'openalex' ? searchOpenAlex(query, signal) : searchCrossref(query, signal);
}

// ---------------------------------------------------------------------------
// BibTeX generation
// ---------------------------------------------------------------------------

/** Words never used as the key's title component ("Attention Is *All* You Need"). */
const TITLE_STOPWORDS = new Set([
  'a', 'an', 'the', 'on', 'of', 'in', 'for', 'and', 'or', 'to', 'with', 'from',
  'by', 'at', 'as', 'is', 'are', 'was', 'were', 'its', 'their', 'this', 'that',
]);

function truncate(text: string, max = MAX_ABSTRACT_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Collapse internal newlines/tabs so the value fits on one BibTeX line. */
function cleanBibValue(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** ASCII alphanumeric only, as required for portable citation keys. */
function sanitizeKeyPart(part: string): string {
  // Transliterate Latin diacritics first ("Ocaña" → "Ocana", "Müller" →
  // "Muller") so accented author names keep readable key components.
  return part
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]/g, '');
}

/** "Donald E. Knuth" → "Knuth"; "Knuth, Donald" → "Knuth". */
function firstAuthorLastName(authors: string[]): string {
  const name = authors[0]?.trim();
  if (!name) return 'Anon';
  const lastWord = name.split(/[\s,]+/).filter(Boolean).pop() ?? 'Anon';
  return sanitizeKeyPart(lastWord) || 'Anon';
}

/** First non-stopword, alphanumeric fragment of the title, capitalized. */
function firstSignificantWord(title: string): string {
  for (const word of title.split(/[^A-Za-z0-9]+/)) {
    if (!word) continue;
    if (TITLE_STOPWORDS.has(word.toLowerCase())) continue;
    const sanitized = sanitizeKeyPart(word);
    if (sanitized) return sanitized[0].toUpperCase() + sanitized.slice(1);
  }
  return 'Paper';
}

/**
 * Citation key: `${FirstAuthorLastName}${Year}${FirstSignificantWordOfTitle}`
 * e.g. "Attention Is All You Need" (Vaswani et al., 2017) → Vaswani2017Attention.
 */
export function citationKey(paper: AcademicPaper): string {
  const year = paper.year > 0 ? String(paper.year) : 'ND';
  return `${firstAuthorLastName(paper.authors)}${year}${firstSignificantWord(paper.title)}`;
}

/**
 * Build a clean `@article` (venue known) or `@misc` BibTeX entry directly
 * from the normalized metadata — no DOI redirects, no external services.
 */
export function paperToBibTeX(paper: AcademicPaper): { key: string; bibtex: string } {
  const key = citationKey(paper);
  const type = paper.venue ? 'article' : 'misc';

  const lines: string[] = [
    `@${type}{${key},`,
    `  title = {${cleanBibValue(paper.title)}},`,
  ];
  if (paper.authors.length > 0) {
    lines.push(`  author = {${paper.authors.map(cleanBibValue).join(' and ')}}`);
  }
  lines.push(`  year = {${paper.year > 0 ? paper.year : 'n.d.'}},`);
  if (paper.venue) {
    lines.push(`  ${type === 'article' ? 'journal' : 'howpublished'} = {${cleanBibValue(paper.venue)}},`);
  }
  if (paper.doi) {
    lines.push(`  doi = {${cleanBibValue(paper.doi)}}`);
  }
  lines.push('}');

  return { key, bibtex: lines.join('\n') };
}
