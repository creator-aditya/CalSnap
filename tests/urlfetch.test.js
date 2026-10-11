/**
 * Link reading tests - Step 10, extended to actually read a shared link.
 *
 * Retrieval needs the network, so the network itself is not tested here: what is
 * tested is the part that decides whether the details are correct, using saved
 * page markup of the kind event sites really publish. A live check against a real
 * URL lives in tools/check-url.js, which is run by hand.
 *
 * Run with: npm test      (or: node --test tests)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Extractor, Validation, CalendarCore } = require('./load-globals.js');
const { readGoogleUrl } = require('./google-url-reader.js');

const ROOT = require('node:path').join(__dirname, '..');
require(require('node:path').join(ROOT, 'js', 'urlfetch.js'));
const UrlFetch = globalThis.UrlFetch;

const NOW = new Date(2026, 0, 2, 10, 0, 0);

/* -------------------------------------------------------------------------- *
 * Recognising a link
 * -------------------------------------------------------------------------- */

test('url: a pasted link is recognised, with or without a scheme', () => {
    assert.equal(UrlFetch.looksLikeUrl('https://in.bookmyshow.com/events/sharon-verma-live/ET00521481'), true);
    assert.equal(UrlFetch.looksLikeUrl('http://example.com/events/1'), true);
    assert.equal(UrlFetch.looksLikeUrl('www.example.com/events/1'), true);
    assert.equal(UrlFetch.looksLikeUrl('example.com/events/1'), true);

    assert.equal(UrlFetch.looksLikeUrl('Team meeting tomorrow at 2 PM'), false);
    assert.equal(UrlFetch.looksLikeUrl(''), false);
    assert.equal(UrlFetch.looksLikeUrl('just some words'), false);
});

test('url: a bare domain gets a scheme, rubbish does not become a URL', () => {
    assert.equal(UrlFetch.normalizeUrl('example.com/events/1'), 'https://example.com/events/1');
    assert.equal(UrlFetch.normalizeUrl('localhost'), '');
    assert.equal(UrlFetch.normalizeUrl('not a url'), '');
});

/* -------------------------------------------------------------------------- *
 * Reading a page that publishes schema.org Event data
 * -------------------------------------------------------------------------- */

const JSON_LD_PAGE = `<!DOCTYPE html>
<html><head>
<title>Sharon Verma Live - BookMyShow</title>
<meta property="og:title" content="Sharon Verma Live">
<meta property="og:description" content="Stand up comedy show. Age limit 16+. Languages: English, Hindi.">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Event",
  "name": "Sharon Verma Live",
  "startDate": "2026-11-14T19:30:00+05:30",
  "endDate": "2026-11-14T21:00:00+05:30",
  "location": {
    "@type": "Place",
    "name": "The Comedy Club",
    "address": {
      "@type": "PostalAddress",
      "streetAddress": "12 Linking Road",
      "addressLocality": "Mumbai",
      "addressRegion": "Maharashtra",
      "postalCode": "400050"
    }
  },
  "description": "Sharon Verma returns with a brand new hour of stand up."
}
</script>
</head><body>
<nav>Search for Movies, Events, Plays, Sports and Activities</nav>
<h1>Sharon Verma Live</h1>
<p>Book Now</p>
</body></html>`;

test('url: schema.org Event data is read exactly', () => {
    const page = UrlFetch.parseHtml(JSON_LD_PAGE);

    assert.equal(page.title, 'Sharon Verma Live');
    assert.equal(page.startDate, '2026-11-14T19:30:00+05:30');
    assert.equal(page.endDate, '2026-11-14T21:00:00+05:30');
    assert.match(page.location, /The Comedy Club/);
    assert.match(page.location, /Mumbai/);
    assert.match(page.description, /brand new hour/);
    assert.equal(page.source, 'json-ld');
});

test('url: page data fills the form exactly, without a date guess', () => {
    const page = UrlFetch.parseHtml(JSON_LD_PAGE);
    const extracted = Extractor.extract('Sharon Verma Live\n' + page.text, { now: NOW, page });

    assert.equal(extracted.title, 'Sharon Verma Live');
    assert.equal(extracted.date, '2026-11-14');
    assert.equal(extracted.startTime, '19:30');
    assert.equal(extracted.endTime, '21:00');
    assert.match(extracted.location, /The Comedy Club/);
    assert.deepEqual(extracted.missing, [], 'a complete page must leave nothing to ask for');
});

test('url: the page event becomes the right Google Calendar entry', () => {
    const page = UrlFetch.parseHtml(JSON_LD_PAGE);
    const extracted = Extractor.extract(page.text, { now: NOW, page });
    const validated = Validation.validate(extracted, { now: NOW });
    assert.equal(validated.ok, true, JSON.stringify(validated.errors));

    const event = readGoogleUrl(CalendarCore.generateGoogleUrl(validated.event));
    assert.deepEqual(event.summary(), {
        title: 'Sharon Verma Live',
        date: '2026-11-14',
        startTime: '19:30',
        endTime: '21:00',
        location: extracted.location
    });
});

/* -------------------------------------------------------------------------- *
 * Pages that publish only Open Graph tags
 * -------------------------------------------------------------------------- */

const OG_PAGE = `<!DOCTYPE html>
<html><head>
<meta property="og:title" content="Winter Craft Fair">
<meta property="og:description" content="Over 60 makers, mulled wine and a brass band.">
<meta property="event:start_time" content="2026-12-05T10:00:00">
<meta property="og:street-address" content="The Old Mill, Riverside">
</head><body><h1>Winter Craft Fair</h1><p>Saturday 5 December 2026, 10:00 AM to 4:00 PM</p></body></html>`;

test('url: Open Graph tags are used when there is no JSON-LD', () => {
    const page = UrlFetch.parseHtml(OG_PAGE);

    assert.equal(page.title, 'Winter Craft Fair');
    assert.match(page.description, /60 makers/);
    assert.equal(page.location, 'The Old Mill, Riverside');
    assert.equal(page.startDate, '2026-12-05T10:00:00');
    assert.equal(page.source, 'open-graph');
});

test('url: the visible text is still used for what the tags omit', () => {
    const page = UrlFetch.parseHtml(OG_PAGE);
    const extracted = Extractor.extract(page.text, { now: NOW, page });

    assert.equal(extracted.title, 'Winter Craft Fair');
    assert.equal(extracted.date, '2026-12-05');
    assert.equal(extracted.startTime, '10:00');
    assert.equal(extracted.endTime, '16:00', 'the end time comes from the page text');
    assert.equal(extracted.location, 'The Old Mill, Riverside');
});

/* -------------------------------------------------------------------------- *
 * A page whose body is plain text (what a reader service returns)
 * -------------------------------------------------------------------------- */

const READER_TEXT = `Title: Sharon Verma Live Comedy Shows - BookMyShow

Markdown Content:
# Sharon Verma Live

Stand up Comedy, Comedy Shows

Sat 14 Nov 2026 - Sat 9 Jan 2027

The Comedy Club, Mumbai

Book Now

Sharon Verma returns with a brand new hour of stand up comedy.`;

/* -------------------------------------------------------------------------- *
 * A reader-service page (what a site that blocks browsers actually returns)
 * -------------------------------------------------------------------------- */

/*
 * BookMyShow answers a direct request with 403, so CalSnap reaches it through a text
 * reader. That output is markdown with the event's facts in an icon block, and the
 * rest of the page is navigation. This fixture is the shape of that response, which
 * previously produced a wrong date (a banner image timestamp), a nonsense location
 * ("Kochi](https://in") and a title made of search keywords.
 */
const READER_PAGE = [
    'Title: Sharon Verma Live  Comedy Shows, Stand up Comedy, Events Events Tickets - BookMyShow',
    '',
    'URL Source: https://in.bookmyshow.com/events/sharon-verma-live/ET00521481',
    '',
    'Markdown Content:',
    '[Skip to main content](https://in.bookmyshow.com/#main-content)',
    '# [Sharon Verma Live ![Image 1](https://x/share.png)](https://in.bookmyshow.com/events/ET00521481)',
    '![Image 2: media-desktop-sharon-verma-live--2026-10-8-t-17-14-58.jpg](https://x/banner.jpg)',
    '[![Image 18](https://x/calendar.png) Sat 14 Nov 2026 - Sat 9 Jan 2027](https://in.bookmyshow.com/events/ET00521481)[![Image 19](https://x/time.png) 7:00 PM](https://in.bookmyshow.com/events/ET00521481)[![Image 20](https://x/duration.png) 1 hour 15 minutes](https://in.bookmyshow.com/events/ET00521481)[![Image 24](https://x/location.png) Sophia Bhabha Auditorium: Mumbai ![Image 25](https://x/navigate.png)](https://in.bookmyshow.com/events/ET00521481)',
    '## About The Event',
    'Some women have it all together. Sharon Verma is not one of them. An hour of stand-up about navigating life with a little experience and a lot of opinions.',
    '## Artists',
    '![Image 5: Sharon Verma](https://x/artist.jpg) Sharon Verma Actor',
    '## You May Also Like',
    'Events around you, book now',
    '1. Home',
    '2. Events',
    'Events in Top Cities Events in Mumbai Events in Kochi',
    'Copyright 2026 Bigtree Entertainment Pvt. Ltd.'
].join('\n');

test('reader: the facts block is read exactly, not the navigation around it', () => {
    const page = UrlFetch.parseHtml(READER_PAGE);

    assert.equal(page.dateText, 'Sat 14 Nov 2026 - Sat 9 Jan 2027');
    assert.equal(page.timeOfDay, '7:00 PM');
    assert.equal(page.location, 'Sophia Bhabha Auditorium, Mumbai');
    assert.equal(page.duration, '1 hour 15 minutes');
});

test('reader: the headline is the event name, without the site keywords', () => {
    const page = UrlFetch.parseHtml(READER_PAGE);
    assert.equal(page.title, 'Sharon Verma Live');
});

test('reader: the whole event comes out right, ready for a calendar', () => {
    const page = UrlFetch.parseHtml(READER_PAGE);
    const extracted = Extractor.extract(page.title + '\n' + page.text, { now: NOW, page });
    const validated = Validation.validate(extracted, { now: NOW });

    // The banner image is named "...-2026-10-8-t-17-14-58.jpg". That 2026-10-08/11
    // used to become the event date; the page's own stated date must win.
    assert.equal(extracted.title, 'Sharon Verma Live');
    assert.equal(extracted.date, '2026-11-14');
    assert.equal(extracted.startTime, '19:00');
    assert.equal(extracted.location, 'Sophia Bhabha Auditorium, Mumbai');
    assert.equal(extracted.description.includes('Kochi'), false, 'no navigation in the description');
    assert.equal(validated.ok, true, JSON.stringify(validated.errors));

    const event = readGoogleUrl(CalendarCore.generateGoogleUrl(validated.event));
    assert.deepEqual(event.summary(), {
        title: 'Sharon Verma Live',
        date: '2026-11-14',
        startTime: '19:00',
        endTime: '20:00', // no end time is stated, so one hour
        location: 'Sophia Bhabha Auditorium, Mumbai'
    });
});

test('reader: the artist photo caption is never taken as the venue', () => {
    const page = UrlFetch.parseHtml(READER_PAGE);
    assert.doesNotMatch(page.location, /^image/i);
    assert.doesNotMatch(page.location, /sharon verma/i);
});

test('reader: boilerplate sections are dropped from the text', () => {
    const page = UrlFetch.parseHtml(READER_PAGE);
    assert.doesNotMatch(page.text, /Events in Top Cities/);
    assert.doesNotMatch(page.text, /Copyright 2026 Bigtree/);
});

test('url: a run of dates is reported as a date, never as an invented time', () => {
    const page = { title: 'Sharon Verma Live', text: READER_TEXT, source: 'reader-text' };
    const extracted = Extractor.extract(page.title + '\n' + page.text, { now: NOW, page });

    assert.equal(extracted.date, '2026-11-14', 'the first date of the run is the start');
    assert.equal(extracted.startTime, '', 'the page never states a time, so none is invented');
    assert.equal(extracted.endTime, '');
    assert.match(extracted.location, /Comedy Club/);
    assert.ok(extracted.missing.includes('startTime'), 'the user is asked for the time');
});

test('reader: the description is the event write-up, not the page furniture', () => {
    const page = UrlFetch.parseHtml(READER_PAGE);
    const extracted = Extractor.extract(page.title + '\n' + page.text, { now: NOW, page });
    const description = extracted.description;

    // What the calendar entry must contain: the page's own words about the event.
    assert.match(description, /Some women have it all together/);
    assert.match(description, /stand-up/);
    assert.match(description, /navigating life with a little experience/);

    // What it must not contain: the page's navigation, its search keywords, its footer.
    for (const junk of [
        'Skip to main content', 'Search for Movies', 'Sign in', 'Gift Cards', 'ListYourShow',
        'Comedy Shows, Stand up Comedy, Events Events Tickets', 'BookMyShow', 'are interested',
        'About The Event', 'Read More', 'Artists', 'M-Ticket', 'Fast-track Entry', 'Learn How',
        'You May Also Like', 'Events in Top Cities', 'Copyright'
    ]) {
        assert.equal(description.includes(junk), false,
            'the description must not contain "' + junk + '": ' + description);
    }

    assert.ok(description.length <= 700, 'the description stays a readable length, was ' + description.length);
});

test('reader: prose scoring separates writing from navigation', () => {
    const prose = 'Some women have it all together. Sharon Verma is not one of them.';
    const labels = 'Stand up Comedy Comedy Shows 121 are interested';
    const menu = 'Movies Stream Events Plays Sports Activities ListYourShow Corporates Offers Gift Cards';
    // The threshold proseFrom() uses to decide a line is worth keeping.
    const KEEP = 0.35;

    assert.ok(UrlFetch.proseScore(prose) > 0.4, 'prose should score high, got ' + UrlFetch.proseScore(prose));
    assert.ok(UrlFetch.proseScore(labels) < KEEP, 'labels must not reach the keep threshold, got ' + UrlFetch.proseScore(labels));
    assert.ok(UrlFetch.proseScore(menu) < KEEP, 'a menu must not reach the keep threshold, got ' + UrlFetch.proseScore(menu));

    assert.equal(UrlFetch.isHeadingLine('About The Event'), true);
    assert.equal(UrlFetch.isHeadingLine('Artists'), true);
    assert.equal(UrlFetch.isHeadingLine('Some women have it all together.'), false);
});

test('reader: a label glued to the first sentence does not survive', () => {
    const glued = 'Sharon Verma Live Stand up Comedy Comedy Shows 121 are interested ' +
        'About The Event Some women have it all together. Sharon Verma is not one of them.';
    const prose = UrlFetch.proseOnly(glued, 700);

    assert.match(prose, /^Some women have it all together/);
    assert.doesNotMatch(prose, /About The Event/);
    assert.doesNotMatch(prose, /are interested/);
});

test('reader: a page with no write-up yields an empty description rather than menus', () => {
    const menus = [
        'Movies Stream Events Plays Sports Activities',
        'ListYourShow Corporates Offers Gift Cards',
        'Events in Mumbai Events in Delhi-NCR Events in Chennai',
        'Copyright 2026 Example Ltd.'
    ].join('\n');
    const page = UrlFetch.parseHtml('<html><body>' + menus + '</body></html>');
    const extracted = Extractor.extract(page.text || menus, { now: NOW, page });

    assert.equal(extracted.description, '', 'navigation must never become the description');
});

test('reader: a long write-up is kept whole, not cut mid-sentence', () => {
    /*
     * Reported: "AURA brings together the energy of a glo..." - the description stopped
     * in the middle of a word, which looks broken in a calendar entry. The limit is now a
     * target that the text is closed at, never a raw character cut.
     */
    const writeUp = 'After taking his AURA to sold-out stadiums and arenas around the world, ' +
        'Diljit Dosanjh is coming home! Following an overwhelming response from fans globally, ' +
        'Diljit is bringing the AURA World Tour to India - taking the celebration PAN India and ' +
        'giving audiences across the country the chance to experience it live. Fresh from his ' +
        "landmark headline performance at London's Wembley Stadium, Diljit returns to the country " +
        'that has shaped his music, culture and journey. And AURA is coming back on a scale like ' +
        'never before. Expect his biggest hits, electrifying bhangra, high-octane performances and ' +
        'a larger-than-life production built for world-class stages. AURA brings together the ' +
        'energy of a global icon with the intimacy of a homecoming, making every night unforgettable.';

    // A write-up of this size must survive untouched, without a stray "...".
    assert.equal(UrlFetch.endAtSentence(writeUp, 1400), writeUp,
        'a description that fits the limit must not be altered at all');

    // Under a tighter limit the text is closed at a sentence, not mid-word.
    const tightened = UrlFetch.endAtSentence(writeUp, 700);
    assert.ok(tightened.length <= 700, 'the tightened text stays within the limit, was ' + tightened.length);
    assert.match(tightened, /[.!?]$/, 'the text must end at a sentence: ' + JSON.stringify(tightened.slice(-60)));
    assert.equal(tightened.includes('glo...'), false, 'no mid-word cut');
    assert.match(tightened, /world-class stages\.$/, 'it ends at the last complete sentence that fits');
});

test('reader: a single sentence longer than the limit is cut at a word, not mid-word', () => {
    const oneLongSentence = 'This is one very long sentence without any internal stop ' + 'word '.repeat(200) + 'end';
    const out = UrlFetch.endAtSentence(oneLongSentence, 200);

    assert.ok(out.length <= 210, 'stays near the limit, was ' + out.length);
    assert.match(out, /\.\.\.$/, 'marked as cut when it could not be closed at a sentence');
    assert.equal(/\bwor\.\.\.$/.test(out), false, 'must not cut in the middle of a word');
});

test('reader: prose selection also ends at a sentence', () => {
    const about = 'About The Event ' + 'Some women have it all together. '.repeat(40);
    const prose = UrlFetch.proseOnly(about, 700);

    assert.match(prose, /together\.$/, 'the selected prose ends at a full stop');
    assert.equal(prose.includes('...'), false, 'no ellipsis when the text closed at a sentence');
});

/* -------------------------------------------------------------------------- *
 * Guards
 * -------------------------------------------------------------------------- */

test('url: an explicit label in the text beats the page, and details are never overwritten', () => {
    // "Event: Design Review" is the user naming the event, so it wins over whatever
    // the page calls itself. The fields the text already supplied stay untouched.
    const page = { title: 'Page Heading', startDate: '2026-01-01T09:00:00', location: 'Somewhere else' };
    const extracted = Extractor.extract(
        'Event: Design Review\nDate: 2026-05-01 at 15:30\nLocation: Studio 2',
        { now: NOW, page }
    );

    assert.equal(extracted.title, 'Design Review');
    assert.equal(extracted.date, '2026-05-01');
    assert.equal(extracted.startTime, '15:30');
    assert.equal(extracted.location, 'Studio 2');
    assert.equal(extracted.sources.pageTitle, 'Page Heading', 'the page title is still reported');
});

test('url: with no label in the text, the page title is preferred over a text guess', () => {
    const page = { title: 'Riverside Summer Gala' };
    const extracted = Extractor.extract('Riverside Summer Gala 5 Book Now', { now: NOW, page });
    assert.equal(extracted.title, 'Riverside Summer Gala', 'no stray date fragment in the name');
});

test('url: a multi-day event keeps both days so the calendar entry is not cut short', () => {
    const page = {
        title: 'Two Day Conference',
        startDate: '2026-03-07T09:00:00',
        endDate: '2026-03-08T17:00:00',
        location: 'Convention Centre',
        description: 'Two full days.'
    };
    const extracted = Extractor.extract(page.title, { now: NOW, page });
    const validated = Validation.validate(extracted, { now: NOW });

    assert.equal(validated.ok, true, JSON.stringify(validated.errors));
    const event = readGoogleUrl(CalendarCore.generateGoogleUrl(validated.event));
    assert.equal(event.date, '2026-03-07');
    assert.equal(event.endDate, '2026-03-08', 'the entry must end on the second day');
});

test('url: a broken JSON-LD block is skipped instead of breaking the page', () => {
    const broken = '<html><head><script type="application/ld+json">{ this is not json }</script>' +
        '<meta property="og:title" content="Fallback Title"></head><body>Hi</body></html>';
    const page = UrlFetch.parseHtml(broken);
    assert.equal(page.title, 'Fallback Title');
});

test('url: html entities and attribute order do not hide a value', () => {
    const html = '<html><head>' +
        '<meta content="Tom &amp; Jerry&#39;s Big Show" property="og:title">' +
        '</head><body></body></html>';
    assert.equal(UrlFetch.parseHtml(html).title, "Tom & Jerry's Big Show");
});

test('url: scripts and styles never leak into the extracted text', () => {
    const html = '<html><head><style>body{color:red}</style>' +
        '<script>var tracking = "secret analytics payload";</script></head>' +
        '<body><h1>Real Event</h1><p>1 January 2027 at 10:00</p></body></html>';
    const text = UrlFetch.parseHtml(html).text;

    assert.match(text, /Real Event/);
    assert.doesNotMatch(text, /secret analytics/);
    assert.doesNotMatch(text, /color:red/);
});

test('url: a plain-text page with no event data yields nothing invented', () => {
    const page = UrlFetch.parseHtml('<html><body><p>Welcome to our site.</p></body></html>');
    const extracted = Extractor.extract(page.text || 'Welcome to our site.', { now: NOW, page });

    assert.equal(extracted.date, '');
    assert.equal(extracted.startTime, '');
    assert.equal(Validation.validate(extracted, { now: NOW }).ok, false);
});
