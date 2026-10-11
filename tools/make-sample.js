/**
 * Produces a real .ics file from the sample event so the output can be inspected
 * (and imported into a calendar) by hand.
 *
 *   npm run sample        # writes tools/sample-event.ics
 *
 * The pipeline used here is exactly the one js/ui.js uses: extract -> validate ->
 * generate. It is a convenience script, not part of the application.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Extractor, Validation, CalendarCore } = require('../tests/load-globals.js');

const TEXT = [
    'Annual Design Summit 2026',
    'Saturday, 14 March 2026',
    'Time: 9:30 AM - 4:00 PM',
    'Location: Riverside Convention Centre, Hall B',
    '',
    'Join 300 designers for a day of talks, workshops and portfolio reviews.',
    'Tickets and the full agenda: https://example.com/summit-2026'
].join('\n');

const extracted = Extractor.extract(TEXT);
const validated = Validation.validate(Object.assign({}, extracted, { reminder: '15' }));

if (!validated.ok) {
    console.error('The sample event did not validate:', validated.errors);
    process.exit(1);
}

const ics = CalendarCore.generateICS(validated.event);
const target = path.join(__dirname, 'sample-event.ics');
fs.writeFileSync(target, ics, 'utf8');

console.log('Sample event written to', target);
console.log('');
console.log('Extracted from the pasted text:');
console.log('  title      ', JSON.stringify(extracted.title));
console.log('  date       ', extracted.date);
console.log('  start/end  ', extracted.startTime, '->', extracted.endTime);
console.log('  location   ', JSON.stringify(extracted.location));
console.log('  reminder   ', validated.event.reminder, 'minutes before');
console.log('');
console.log('Google Calendar link:');
console.log(' ', CalendarCore.generateGoogleUrl(validated.event));
