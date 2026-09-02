// Every source the dashboard reads, in one place.
// To add a panel later: add an entry here. Nothing else needs to change.
//
// lane   'wire'     — news outlets, clustered and attributed per item
//        'official' — governments and intergovernmental bodies, verbatim
//        'hazard'   — physical-world alerts (seismic, weather)
// kind   how to parse the response. 'rss' covers RSS 2.0, RDF and Atom.
//        The others are JSON APIs with their own shapes (see feeds.mjs),
//        except 'iedc', which is scraped markup — that agency publishes no
//        feed at all. See parseIedc.
// limit  cap on items taken from one source, newest first. Only set where a
//        feed is far more prolific than its lane-mates.
// place  optional locality tag. Sources carrying one still feed their lane
//        normally; the tag only lets a view gather them without the client
//        having to keep its own list of outlet names.

export const SOURCES = [
  // ---- wire -------------------------------------------------------------
  { id: 'bbc-world',   lane: 'wire', outlet: 'BBC',        kind: 'rss',
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { id: 'aljazeera',   lane: 'wire', outlet: 'Al Jazeera', kind: 'rss',
    url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { id: 'guardian',    lane: 'wire', outlet: 'Guardian',   kind: 'rss',
    url: 'https://www.theguardian.com/world/rss' },
  { id: 'npr-world',   lane: 'wire', outlet: 'NPR',        kind: 'rss',
    url: 'https://feeds.npr.org/1004/rss.xml' },
  { id: 'dw-world',    lane: 'wire', outlet: 'DW',         kind: 'rss',
    url: 'https://rss.dw.com/rdf/rss-en-world' },

  // Indiana. Regional outlets sit in the same lane as the world wire, so a
  // Noblesville story competes with Gaza on recency and significance — which
  // is the intended behaviour: it surfaces when it is genuinely the most
  // active thing, and stays down when it is not.
  { place: 'indiana', id: 'in-capital-chronicle', lane: 'wire', outlet: 'Indiana Capital Chronicle', kind: 'rss',
    // Publishes ~100 items where the other wire feeds carry 10–45.
    limit: 20,
    url: 'https://indianacapitalchronicle.com/feed/' },
  { place: 'indiana', id: 'mirror-indy', lane: 'wire', outlet: 'Mirror Indy',      kind: 'rss',
    // Indianapolis metro. Chosen over the Indianapolis Business Journal, whose
    // feed still resolves but stopped updating in 2022.
    url: 'https://mirrorindy.org/feed/',
    // WordPress signs off every excerpt with "The post … appeared first on …".
    stripSummary: /\s*The post\b[\s\S]*?appeared first on[\s\S]*$/i },
  { place: 'indiana', id: 'current-hc',  lane: 'wire', outlet: 'Current',          kind: 'rss',
    // Hamilton County hyperlocal — Noblesville, Carmel, Fishers, Westfield.
    url: 'https://youarecurrent.com/feed/' },
  { place: 'indiana', id: 'hc-reporter', lane: 'wire', outlet: 'Hamilton Co. Reporter', kind: 'rss',
    url: 'https://readthereporter.com/feed/' },

  // ---- official ---------------------------------------------------------
  { id: 'whitehouse',  lane: 'official', outlet: 'White House',      kind: 'rss',
    url: 'https://www.whitehouse.gov/news/feed/' },
  { id: 'dod-news',    lane: 'official', outlet: 'Defense Dept',     kind: 'rss',
    url: 'https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=945&max=20' },
  { id: 'dod-release', lane: 'official', outlet: 'Defense Dept',     kind: 'rss',
    url: 'https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=9&Site=945&max=20' },
  { id: 'un-news',     lane: 'official', outlet: 'United Nations',   kind: 'rss',
    url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml' },
  { id: 'cisa',        lane: 'official', outlet: 'CISA',             kind: 'rss',
    url: 'https://www.cisa.gov/cybersecurity-advisories/all.xml',
    // Every CISA description opens with this boilerplate link text.
    stripSummary: /^View CSAF\s*(Summary)?\s*/i },
  { id: 'congress',    lane: 'official', outlet: 'Congress',         kind: 'rss',
    url: 'https://www.congress.gov/rss/most-viewed-bills.xml' },
  { id: 'fedreg',      lane: 'official', outlet: 'Federal Register', kind: 'federal-register',
    url: 'https://www.federalregister.gov/api/v1/documents.json'
       + '?per_page=20&order=newest'
       + '&fields[]=title&fields[]=html_url&fields[]=publication_date'
       + '&fields[]=type&fields[]=agencies' },

  // Noblesville runs CivicPlus, which exposes each module as its own feed.
  // ModID=1 is News Flash, ModID=65 the agenda publisher. The calendar
  // (ModID=58) and page-change feed (ModID=76) are deliberately left out:
  // neither is news.
  { place: 'indiana', id: 'noblesville',  lane: 'official', outlet: 'Noblesville',      kind: 'rss',
    url: 'https://www.noblesville.in.gov/RSSFeed.aspx?ModID=1&CID=All' },
  { place: 'indiana', id: 'noblesville-agendas', lane: 'official', outlet: 'Noblesville Agendas', kind: 'rss',
    url: 'https://www.noblesville.in.gov/RSSFeed.aspx?ModID=65&CID=All',
    // CivicPlus appends a standing note about appointed officers to some
    // committee titles, turning "Council Roads Committee" into 200 characters.
    stripTitle: /\s*-\s*A list of each appointed officer[\s\S]*$/i,
    // The same note is repeated in the description, ahead of the part that
    // does carry information ("Minutes added or updated").
    stripSummary: /\s*-?\s*A list of each appointed officer[\s\S]*?Boards-Commissions\.?/i },
  { place: 'indiana', id: 'iedc',         lane: 'official', outlet: 'Indiana Econ Dev', kind: 'iedc',
    // Scraped, not a feed — IEDC publishes none. Only the five currently
    // featured articles are on the page, so this is current news, not an
    // archive.
    url: 'https://iedc.in.gov/events/news' },

  // ---- hazard -----------------------------------------------------------
  { id: 'usgs',        lane: 'hazard', outlet: 'USGS',    kind: 'usgs',
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson' },
  { id: 'nws',         lane: 'hazard', outlet: 'NWS',     kind: 'nws',
    url: 'https://api.weather.gov/alerts/active?severity=Extreme&status=actual' },
];

// How long a source's response is reused before it is fetched again.
export const TTL = { feed: 5 * 60 * 1000, market: 3 * 60 * 1000 };
