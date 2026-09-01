// Every source the dashboard reads, in one place.
// To add a panel later: add an entry here. Nothing else needs to change.
//
// lane   'wire'     — news outlets, clustered and attributed per item
//        'official' — governments and intergovernmental bodies, verbatim
//        'hazard'   — physical-world alerts (seismic, weather)
// kind   how to parse the response. 'rss' covers RSS 2.0, RDF and Atom.
//        The others are JSON APIs with their own shapes (see feeds.mjs).

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

  // ---- hazard -----------------------------------------------------------
  { id: 'usgs',        lane: 'hazard', outlet: 'USGS',    kind: 'usgs',
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson' },
  { id: 'nws',         lane: 'hazard', outlet: 'NWS',     kind: 'nws',
    url: 'https://api.weather.gov/alerts/active?severity=Extreme&status=actual' },
];

// How long a source's response is reused before it is fetched again.
export const TTL = { feed: 5 * 60 * 1000, market: 3 * 60 * 1000 };
