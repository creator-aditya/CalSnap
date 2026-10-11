/**
 * Live check: read a real event page and print the details CalSnap found.
 *
 *   node tools/check-url.js https://in.bookmyshow.com/events/sharon-verma-live/ET00521481
 *
 * The offline suite (tests/urlfetch.test.js) proves the parsing is correct against
 * saved markup. This script proves the retrieval route works against the live site,
 * which is the part that depends on the site and on the network.
 *
 * It needs Node 18+ for fetch, and it sends the URL to the same reader service the
 * browser build uses when a site blocks a direct request.
 */
'use strict';

const path = require('node:path');
const { Extractor, Validation, CalendarCore, UrlFetch } = require(path.join(__dirname, '..', 'tests', 'load-globals.js'));

const target = process.argv[2] || 'https://in.bookmyshow.com/events/sharon-verma-live/ET00521481';

function line(label, value) {
    console.log('  ' + label.padEnd(16) + (value === '' || value == null ? '(empty)' : value));
}

(async function main() {
    console.log('URL    :', target);
    console.log('Looks like a URL:', UrlFetch.looksLikeUrl(target));
    console.log('');

    const result = await UrlFetch.load(target);

    console.log('Retrieval');
    line('ok', String(result.ok));
    line('route', result.route || '(none)');
    if (!result.ok) {
        line('reason', result.reason);
        console.log('\nNo details could be read. Paste the event text instead.');
        process.exitCode = 1;
        return;
    }

    const page = result.page;
    console.log('');
    console.log('What the page declared');
    line('source', page.source);
    line('title', page.title);
    line('startDate', page.startDate);
    line('endDate', page.endDate);
    line('location', page.location);
    line('text length', String((page.text || '').length));

    const combined = (page.title ? page.title + '\n' : '') + (page.text || '');
    const extracted = Extractor.extract(combined, { page });
    const validated = Validation.validate(extracted);

    console.log('');
    console.log('Details CalSnap would put in the form');
    line('title', extracted.title);
    line('date', extracted.date);
    line('start time', extracted.startTime);
    line('end time', extracted.endTime);
    line('location', extracted.location);
    line('missing', extracted.missing.join(', '));
    line('valid', String(validated.ok));
    if (!validated.ok) validated.errors.forEach((error) => line('error', error.message));
    validated.warnings.forEach((warning) => line('warning', warning.message));

    if (validated.ok) {
        console.log('');
        console.log('Google Calendar link');
        console.log('  ' + CalendarCore.generateGoogleUrl(validated.event));
    } else {
        console.log('');
        console.log('The form would ask the user for: ' + extracted.missing.join(', '));
    }
})().catch((error) => {
    console.error('Check failed:', error && error.message);
    process.exitCode = 1;
});
