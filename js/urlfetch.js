/**
 * CalSnap - web page retrieval for shared links.
 *
 * Kept separate from js/extractor.js on purpose: this file only turns a URL into
 * text (and, when the page offers it, structured event data). Turning that text
 * into an event is the extractor's job.
 *
 * Why this is not a plain `fetch`
 * -------------------------------
 * A browser cannot read a page from another origin: the response is blocked by
 * CORS, and many event sites answer an unknown client with 403 anyway (BookMyShow
 * does). CalSnap has no server, so it tries three routes in order and reports
 * honestly when every one fails:
 *
 *   1. direct   - works when the site sends CORS headers
 *   2. reader   - a text-extraction service that returns the page as readable
 *                 text; used only when asked for, and the URL is sent to it
 *   3. reader raw - the same service, asked for the HTML, so JSON-LD can be read
 *
 * Nothing is stored, and the app never claims a page was read when it was not.
 */
(function (root) {
    'use strict';

    var READER_ENDPOINT = 'https://r.jina.ai/';
    var READ_TIMEOUT_MS = 20000;

    var REASON = {
        noUrl: 'That does not look like a web address.',
        blocked: 'The page could not be read: the site blocks requests from a browser that is not ' +
            'showing the page, and CalSnap has no server to fetch it for you.',
        offline: 'The page could not be reached. Check your connection and try again.',
        empty: 'The page was reached but contained no readable event details.'
    };

    /** Does this look like a URL the user wants opened? */
    function looksLikeUrl(text) {
        var value = String(text || '').trim();
        if (!value) return false;
        // http(s)://... or a bare domain such as example.com/events/123
        return /^https?:\/\/\S+$/i.test(value) ||
            /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/i.test(value);
    }

    /** Adds a scheme when the user typed a bare domain. */
    function normalizeUrl(text) {
        var value = String(text || '').trim();
        if (!value) return '';
        if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
        try {
            var parsed = new URL(value);
            if (!parsed.hostname || parsed.hostname.indexOf('.') === -1) return '';
            return parsed.toString();
        } catch (error) {
            void error;
            return '';
        }
    }

    /** Decode the HTML entities a page puts in its meta tags. */
    function decodeEntities(value) {
        return String(value == null ? '' : value)
            .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, function (whole, entity) {
                var named = {
                    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
                    ndash: '-', mdash: '-', hellip: '...', rsquo: "'", lsquo: "'",
                    rdquo: '"', ldquo: '"', middot: '-', bull: '-', deg: ' '
                };
                var key = String(entity).toLowerCase();
                if (named[key] !== undefined) return named[key];
                if (key.charAt(0) === '#') {
                    var code = key.charAt(1) === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
                    if (!isNaN(code)) return String.fromCharCode(code);
                }
                return ' ';
            })
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

    /** <meta property="og:title" content="..."> in either attribute order. */
    function metaContent(html, names) {
        for (var i = 0; i < names.length; i++) {
            var name = names[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            var patterns = [
                new RegExp('<meta[^>]+(?:property|name|itemprop)=["\']' + name + '["\'][^>]*content=["\']([^"\']*)["\']', 'i'),
                new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name|itemprop)=["\']' + name + '["\']', 'i')
            ];
            for (var p = 0; p < patterns.length; p++) {
                var match = html.match(patterns[p]);
                if (match && match[1].trim()) return decodeEntities(match[1]);
            }
        }
        return '';
    }

    /** Every application/ld+json block on the page, parsed. */
    function jsonLdBlocks(html) {
        var blocks = [];
        var pattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
        var match;
        while ((match = pattern.exec(html)) !== null) {
            var text = match[1].trim().replace(/^<!--/, '').replace(/-->$/, '').trim();
            if (!text) continue;
            try {
                blocks.push(JSON.parse(text));
            } catch (error) {
                void error; // a malformed block is skipped, not fatal
            }
        }
        return blocks;
    }

    function typeOf(node) {
        var type = node && node['@type'];
        if (Array.isArray(type)) return type.join(' ').toLowerCase();
        return String(type || '').toLowerCase();
    }

    /** Depth-first walk over @graph and nested arrays. */
    function flatten(node, out) {
        out = out || [];
        if (!node || typeof node !== 'object') return out;
        if (Array.isArray(node)) {
            node.forEach(function (entry) { flatten(entry, out); });
            return out;
        }
        out.push(node);
        if (node['@graph']) flatten(node['@graph'], out);
        return out;
    }

    function firstString(value) {
        if (value == null) return '';
        if (typeof value === 'string') return decodeEntities(value);
        if (typeof value === 'number') return String(value);
        if (Array.isArray(value)) {
            for (var i = 0; i < value.length; i++) {
                var found = firstString(value[i]);
                if (found) return found;
            }
            return '';
        }
        if (typeof value === 'object') return firstString(value.name || value['@value'] || value.text || '');
        return '';
    }

    /**
     * schema.org Place / PostalAddress -> one line.
     *
     * A Place usually carries both a name and an address ("The Comedy Club" at
     * "12 Linking Road, Mumbai"): both are kept, because the venue name alone loses
     * the city, and the address alone loses the venue name.
     */
    function placeText(value) {
        if (!value) return '';
        if (typeof value === 'string') return decodeEntities(value);

        var first = Array.isArray(value) ? value[0] : value;
        if (!first || typeof first !== 'object') return firstString(first);

        var parts = [firstString(first.name)];
        var address = first.address;
        if (address && typeof address === 'object') {
            parts.push(
                firstString(address.streetAddress),
                firstString(address.addressLocality),
                firstString(address.addressRegion),
                firstString(address.postalCode)
            );
        } else {
            parts.push(firstString(address));
        }

        return parts
            .map(function (part) { return String(part || '').trim(); })
            .filter(Boolean)
            .join(', ')
            .replace(/\s*,\s*/g, ', ')
            .replace(/(?:,\s*)+/g, ', ')
            .replace(/^[,\s]+|[,\s]+$/g, '');
    }

    var UrlFetch = {

        REASON: REASON,
        READER_ENDPOINT: READER_ENDPOINT,
        READER_ICON: '\u200b\u200b', // a reader service marks a fact line with this

        looksLikeUrl: looksLikeUrl,
        normalizeUrl: normalizeUrl,
        decodeEntities: decodeEntities,
        metaContent: metaContent,

        /**
         * Read the block of facts an event page shows next to its icons.
         *
         * A reader service renders those images without their URL, so the lines that
         * carry the real details are the ones with an empty-alt image marker in front:
         *
         *   [Image 18]() Sat 14 Nov 2026 - Sat 9 Jan 2027
         *   [Image 19]() 7:00 PM
         *   [Image 24]() Sophia Bhabha Auditorium: Mumbai
         *
         * Matching them directly is far more reliable than scanning the whole page,
         * where navigation text supplies a wrong date and a wrong venue.
         */
        eventFacts: function (markdown) {
            var facts = { dates: [], times: [], venue: '', duration: '' };
            // A reader service writes the fact block as one line per fact, each starting
            // with an image marker:
            //
            //   [Image 18](...calendar.png) Sat 14 Nov 2026 - Sat 9 Jan 2027
            //   [Image 19](...time.png) 7:00 PM
            //   [Image 24](...location.png) Sophia Bhabha Auditorium: Mumbai
            //
            // The whole block can itself sit inside one markdown link, so the text is
            // split on the markers first: matching greedily across the line took the
            // first marker and swallowed every fact after it.
                // A reader service writes the fact block as one line per fact, each
                // starting with an image marker:
                //
                //   [Image 18](...calendar.png) Sat 14 Nov 2026 - Sat 9 Jan 2027
                //   [Image 19](...time.png) 7:00 PM
                //   [Image 24](...location.png) Sophia Bhabha Auditorium: Mumbai
                //
                // The block can sit inside one markdown link and the whole page can be a
                // single line, so the text is split into one record per fact first:
                // matching greedily across lines took only the first fact.
                var records = String(markdown || '')
                    .replace(/\[Image\s+\d+\s*\]\([^)]*\)/gi, '\n')
                    .split('\n');
                var segments = ['', ''];
                for (var s = 1; s < records.length; s++) segments.push(records[s]);

            for (var i = 1; i < segments.length; i++) {
                // Each segment runs until the markdown markup of the next link, and the
                // venue segment may carry a trailing "! [Image 25]" for a map icon.
                var value = String(segments[i])
                    .split(/\]\(|<|\n/)[0]
                    .replace(/!?\s*\[[^\]]*\]/g, ' ')
                    .replace(/[\[\]()]/g, ' ')
                    .replace(/\s{2,}/g, ' ')
                    .replace(/^[\s!*·•|,;:-]+|[\s!*·•|,;:-]+$/g, '')
                    .trim();

                if (!facts.times.length && /\b\d{1,2}:\d{2}\s*(?:am|pm)\b/i.test(value)) {
                    facts.times.push((value.match(/\b\d{1,2}:\d{2}\s*(?:am|pm)\b/i) || [''])[0]);
                    continue;
                }
                if (/\b\d{1,2}\s+\w{3,9}\s+\d{4}/.test(value) && value.length <= 60) {
                    facts.dates.push(value);
                    continue;
                }
                if (!facts.duration && /^\s*\d+\s*(?:hour|hr|min)/i.test(value)) {
                    facts.duration = value;
                    continue;
                }
                // A venue is the fact that reads "Name: City" - and is not an artist
                // photo caption such as "Image 5, Sharon Verma", nor the reader service
                // reporting its own failure ("Warning: Target URL returned error 404"),
                // nor an arbitrary sentence that happens to contain a colon.
                var venueMatch = value.match(/^(.{3,70}?):\s*([A-Z][A-Za-z\s]{2,30})$/);
                var looksLikeNotice = /^(?:warning|error|notice|target url|url source)\b/i.test(value) ||
                    /\b(?:returned error|not found|forbidden|timed out|unavailable)\b/i.test(value);
                var venueWords = /\b(?:club|hall|centre|center|theatre|theater|auditorium|arena|stadium|grounds?|park|rooms?|office|studio|gallery|museum|library|hotel|resort|restaurant|cafe|café|bar|pub|lounge|mall|convention|academy|institute|campus|school|college|university|church|temple|mosque|marina|pavilion|gardens?|palace|mill|warehouse|rooftop|banquet|society|sabha|bhavan|bhawan|kendra|maidan)\b/i;
                var placeish = venueWords.test(value) || value.split(/\s+/).length >= 3;
                if (!facts.venue && venueMatch && placeish && !looksLikeNotice &&
                    !/\bimage\b|\bactor\b|\bartist\b/i.test(value)) {
                    facts.venue = venueMatch[1].trim() + ', ' + venueMatch[2].trim();
                }
            }

            return facts;
        },

        /**
         * Drop the parts of a reader page that are never the event: related events,
         * the city list, the footer, the copyright notice.
         *
         * Left in, they supply a wrong date (a banner image timestamp) and a wrong
         * venue ("Events in Kochi"), which the user would then have to notice and fix.
         */
        stripBoilerplate: function (text) {
            // A reader page can arrive as one line, so the footer and the related-events
            // block are cut at their first inline marker, not only at a line start.
            var inline = /(?:\s|^)(?:\d+\.\s*)?(?:you may also like|events around you|events in top cities|book your cal(?:e|a)nder|more events|copyright\s+\d{4}|terms (?:&|and) conditions|privacy policy|list your show|got a show|24\/7 customer care|resend booking confirmation|subscribe to the newsletter)/i;
            var out = String(text || '');
            var match = out.match(inline);
            if (match && match.index > 40) out = out.slice(0, match.index);

            var lines = out.split('\n');
            var drop = /^(?:\d+\.\s+)?(?:home|events|comedy shows|movies|stream|plays|sports|activities|sign in|offers|gift cards|corporates|listyourshow|skip to main content|search for movies)/i;
            var kept = [];

            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (!line) continue;
                if (drop.test(line)) continue;
                kept.push(line);
            }

            return kept.join('\n').trim();
        },

        /**
         * The written description of the event, when the page has one.
         *
         * An event page carries far more navigation than prose: taking the whole page
         * gave a calendar entry made of menus and search keywords. The page's own
         * "About" section is the part written for a reader, so it is preferred, and if
         * that is missing the prose is picked out line by line.
         *
         * @returns {string} '' when the page has nothing that reads as a description
         */
        aboutSection: function (text) {
            var lines = String(text || '').split('\n');
            // A markdown heading may still carry its "#" markers at this point.
            var heading = /^#{0,6}\s*(?:about (?:the )?(?:event|show|this event)|event details?|about this|about|overview|description|synopsis|the show|details)\s*$/i;
            var stopAt = /^#{0,6}\s*(?:artists?|cast|m-?ticket|terms|venue|you may also like|reviews?|gallery|photos?|faqs?|offers?|sponsors?|organiser|organizer|contact|follow|similar|recommended)\b/i;
            var collected = [];
            var started = false;

            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (!started) {
                    if (heading.test(line)) started = true;
                    continue;
                }
                if (stopAt.test(line)) break;
                if (!line) {
                    if (collected.length) break;
                    continue;
                }
                collected.push(line);
                if (collected.join(' ').length > 1200) break;
            }

            var about = collected.join(' ').replace(/\s{2,}/g, ' ').replace(/^[\s,;:–—-]+/, '').trim();
            if (!about) return '';

            // The collected block always starts with the page furniture that precedes the
            // heading (the heading itself is glued to the text that follows it), so the
            // prose is selected out of it rather than the block being returned as it is.
            var prose = this.proseOnly(about, 700);
            if (prose) return prose;

            // No labelled section: pick the descriptive lines out of the page instead.
            return this.proseFrom(text, 700);
        },

        /**
         * How much a line reads like written prose rather than navigation.
         *
         * Navigation is a list of capitalised labels with almost no connecting words
         * ("Stand up Comedy Comedy Shows"); real prose is mostly lower case, uses words
         * like "the", "of" and "is", and ends its sentences. The ratio of those
         * connecting words separates the two reliably enough to filter with.
         */
        proseScore: function (line) {
            var text = String(line || '').trim();
            var words = text.split(/\s+/).filter(Boolean);
            if (words.length < 4) return 0;

            var functional = /^(?:a|an|the|of|to|in|on|at|for|with|and|or|but|is|are|was|were|be|been|being|it|its|this|that|these|those|her|his|their|my|our|your|she|he|they|we|you|i|as|by|from|not|no|so|if|when|while|about|into|over|up|out|than|then|there|here|who|which|what|how|all|any|some|every|can|will|would|just|only|very|too|also|please|ae|aajao)$/i;
            var lowercase = 0;
            var linkish = 0;

            words.forEach(function (word) {
                if (functional.test(word.replace(/[^\w']/g, ''))) lowercase++;
                if (/^[A-Z][a-z]+$/.test(word)) linkish++;
                if (/^(?:https?|www)|\]\(/i.test(word)) linkish += 2;
            });

            var score = lowercase / words.length;
            if (/[.!?。]["')\]]?$/.test(text)) score += 0.1;   // finishes a sentence
            if (linkish / words.length > 0.5) score -= 0.2;    // a row of labels
            if (/\bsign in\b|\bgift cards\b|\bbook now\b|\blist your show\b|\bpay tm\b/i.test(text)) score -= 0.3;

            return score;
        },

        /**
         * Pick the descriptive part out of a page.
         *
         * Lines are filtered strictly first (0.35, which a run of labels does not reach),
         * then the prose is selected out of what is left. The strict pass keeps a
         * navigation line from pulling the furniture in, and the second pass removes the
         * section label that is glued to the first real sentence.
         */
        proseFrom: function (text, maxLength) {
            var limit = maxLength || 700;
            var candidates = String(text || '')
                .split('\n')
                .map(function (line) { return line.trim(); })
                .filter(function (line) {
                    return line && !this.isHeadingLine(line) && this.proseScore(line) >= 0.35;
                }, this);

            if (!candidates.length) return '';
            return this.proseOnly(candidates.join(' '), limit);
        },

        /** A section label rather than a sentence: "About The Event", "Artists". */
        isHeadingLine: function (line) {
            var text = String(line || '').trim().replace(/^#{1,6}\s*/, '');
            if (text.length > 40) return false;
            var heading = /^(?:about(?: the)?(?: event| show| this event)?|event details?|overview|description|synopsis|details|the show|artists?|cast|venue|terms(?: &| and) conditions|m-?ticket|reviews?|gallery|faqs?|offers?|similar events|recommended|you may also like|read more|show more|learn how|book now)$/i;
            return heading.test(text);
        },

        /**
         * Trim page furniture off the front of a section and keep only its prose.
         *
         * The "About" heading arrives in the same block as the text that follows it, so a
         * naive slice left "Sharon Verma Live Stand up Comedy Comedy Shows 121 are
         * interested About The Event ..." in front of the real description. Sentences are
         * scored, and the run that reads as writing is what survives.
         */
        proseOnly: function (text, maxLength) {
            var limit = maxLength || 700;
            var value = String(text || '').replace(/\s{2,}/g, ' ').trim();
            if (!value) return '';

            // Split into sentences AND on every section label, on both sides of it. The
            // furniture in front of a description is often one unpunctuated run, and the
            // label is glued to the sentence that follows:
            //   "... 121 are interested About The Event Some women have it all together."
            // Splitting only before the label left "About The Event Some women have it all
            // together.", which scored as prose and kept the label.
            var labelSplit = /\s*\b(?:about(?: the)?(?: event| show| this event)?|event details?|overview|synopsis|description|artists?|cast|venue|m-?ticket|terms(?: &| and) conditions|reviews?|gallery|faqs?|offers?|you may also like|read more|show more|learn how|book now)\b\s*/gi;
            var sentences = value
                .replace(labelSplit, '\n')
                .split(/\n|(?<=[.!?])\s+/)
                .filter(Boolean);

            var kept = [];
            var started = false;

            for (var i = 0; i < sentences.length; i++) {
                var sentence = sentences[i].trim().replace(/^[|,;:–—-]+/, '');
                if (!sentence) continue;

                var trimmedLabel = sentence.replace(/[.!?]+$/, '').trim();
                if (this.isHeadingLine(trimmedLabel)) {
                    if (started) break; // a later section label ends the description
                    continue;           // a leading label is furniture
                }

                if (!started) {
                    // The description begins at the first part that reads as writing.
                    if (this.proseScore(sentence) < 0.2) continue;
                    started = true;
                }
                kept.push(sentence);
                if (kept.join(' ').length >= limit) break;
            }

            var prose = kept.join(' ').replace(/\s{2,}/g, ' ').trim();
            if (prose.length < 40) return '';
            return prose.length > limit ? prose.slice(0, limit - 3).trim() + '...' : prose;
        },

        /**
         * Read structured event data out of a page.
         *
         * Prefers schema.org Event JSON-LD, which is what event sites publish for
         * search engines, then Open Graph tags. Returns raw values only: converting
         * them into a local date and time is the extractor's job.
         *
         * @param {string} html
         * @returns {{title: string, startDate: string, endDate: string, location: string,
         *            description: string, url: string, source: string, text: string}}
         */
        parseHtml: function (html) {
            var page = String(html || '');
            var result = {
                title: '', startDate: '', endDate: '', location: '', description: '',
                url: '', source: '', text: '', dateText: '', timeOfDay: '', duration: ''
            };

            // Facts the page states in its icon block ("Sat 14 Nov 2026 - Sat 9 Jan 2027",
            // "7:00 PM", "Sophia Bhabha Auditorium: Mumbai"). Read from the raw page,
            // because those markers do not survive the markdown cleanup below.
            var facts = this.eventFacts(page);
            result.dateText = facts.dates.join(' ');
            result.timeOfDay = facts.times.length ? facts.times[0] : '';
            result.duration = facts.duration;
            if (facts.venue) result.location = facts.venue;

            var events = [];
            jsonLdBlocks(page).forEach(function (block) {
                flatten(block).forEach(function (node) {
                    if (/\bevent\b/.test(typeOf(node))) events.push(node);
                });
            });

            if (events.length > 0) {
                // The richest Event node wins.
                var best = events.reduce(function (a, b) {
                    var score = function (node) {
                        return (node.startDate ? 2 : 0) + (node.location ? 1 : 0) + (node.name ? 1 : 0);
                    };
                    return score(b) > score(a) ? b : a;
                });

                result.title = firstString(best.name);
                result.startDate = firstString(best.startDate);
                result.endDate = firstString(best.endDate);
                // A multi-day run often carries the real start in the offers/previousStartDate.
                if (!result.startDate) result.startDate = firstString(best.previousStartDate || best.doorTime);
                result.location = placeText(best.location);
                result.description = firstString(best.description);
                result.url = firstString(best.url);
                result.source = 'json-ld';
            }

            // Open Graph fills whatever JSON-LD did not provide (and is all many
            // smaller sites publish).
            if (!result.title) result.title = metaContent(page, ['og:title', 'twitter:title', 'title']);
            if (!result.description) {
                result.description = metaContent(page, ['og:description', 'twitter:description', 'description']);
            }
            if (!result.location) {
                result.location = metaContent(page, [
                    'og:street-address', 'og:locality', 'event:location', 'place:location:latitude'
                ]);
            }
            if (!result.startDate) {
                var start = metaContent(page, [
                    'event:start_time', 'og:start_time', 'article:published_time', 'event:start_date'
                ]);
                if (start) {
                    result.startDate = start;
                    if (!result.source) result.source = 'open-graph';
                }
            }

            result.text = this.stripBoilerplate(this.htmlToText(page));

            // A page's own write-up is a better calendar description than its menus.
            // og:description comes first, then the "About" section, then the prose the
            // page contains. Only text that reads as writing is used: navigation must
            // never end up in the calendar entry.
            if (!result.description) {
                var about = this.aboutSection(result.text);
                if (about) {
                    result.description = about;
                } else {
                    var prose = this.proseFrom(result.text);
                    if (prose) result.description = prose;
                }
            }

            if (!result.title) {
                var headline = this.pageTitle(page);
                if (headline) {
                    result.title = headline;
                    if (!result.source) result.source = 'page-title';
                }
            }

            if (!result.location) {
                var venue = this.venueHint(result.text);
                if (venue) result.location = venue;
            }

            if (!result.source && (result.title || result.text)) {
                result.source = jsonLdBlocks(page).length > 0 ? 'open-graph' : 'text';
            }

            return result;
        },

        /**
         * Turn a page into readable text.
         *
         * Handles both real HTML and the markdown a text reader service returns, so
         * the extractor sees clean lines either way. Markdown link syntax and image
         * URLs are removed here: they are navigation, and leaving them in produced
         * nonsense values such as "Kochi](https://in".
         */
        htmlToText: function (html) {
            var out = String(html || '');

            if (/<\/?[a-z][\s\S]*>/i.test(out)) {
                out = out
                    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
                    .replace(/<!--[\s\S]*?-->/g, ' ')
                    .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|header|footer)>/gi, '\n')
                    .replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<[^>]+>/g, ' ');
            } else {
                // Markdown. A reader service can return the whole page as one line, and
                // line-based cleanup cannot work on that, so the block structure is put
                // back before anything else happens.
                out = out
                    .replace(/\s*\|\s*/g, '\n')
                    .replace(/(?<=[.:!?)\]%])\s+(?=[A-Z0-9#])/g, '\n');
            }

            // A reader service prefixes "Title:" and "URL Source:" lines; keep the
            // title (the caller reads it) and drop the rest of the preamble.
            out = out
                .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')                 // ![alt](url) -> gone
                .replace(/\[([^\]]*)\]\((?:[^)]*)\)/g, '$1')           // [text](url) -> text
                // A reader service prefixes its own "Title:" and "URL Source:" lines. The
                // title is reported separately, so the preamble is dropped here: left in,
                // the extractor reads "Title: ..." as the user labelling the event, which
                // then protects a page-derived date from the page's own stated facts.
                .replace(/^\s*Title:.*$/gim, ' ')
                .replace(/^\s*(?:URL Source|Markdown Content|Published Time|Warning):.*$/gim, ' ')
                .replace(/^#{1,6}\s*/gm, '')                           // markdown headings
                .replace(/^\s*[*+-]\s+/gm, '')                         // list bullets
                .replace(/\*\*|__/g, '')
                .replace(/https?:\/\/\S+/gi, ' ');

            out = decodeEntities(out);

            return out
                .replace(/[ \t\u00a0]+/g, ' ')
                .replace(/\s*\n\s*/g, '\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
        },

        /**
         * The page's own headline, cleanest source first:
         *   1. the main heading the page shows (<h1>, or the first markdown heading)
         *   2. og:title / twitter:title
         *   3. <title>, or the leading "Title:" line a reader service adds
         *
         * Site names and marketing tails are removed ("... Tickets - BookMyShow",
         * "Comedy Shows, Stand up Comedy, Events Events Tickets"), because the calendar
         * entry should read as the event, not as the page's search keywords.
         */
        pageTitle: function (html) {
            var page = String(html || '');

            // A reader service puts the page's own <title> first, which is the most
            // reliable headline it offers.
            var readerTitle = page.match(/^\s*Title:\s*(.+)$/m);
            if (readerTitle && readerTitle[1].trim().length >= 3) {
                return this.cleanTitle(readerTitle[1]);
            }

            var fromMeta = metaContent(page, ['og:title', 'twitter:title']);
            if (fromMeta) return this.cleanTitle(fromMeta);

            // The main heading. Only an <h1> or a single-# markdown heading counts: a
            // "## About The Event" section label is not the event name.
            var heading = page.match(/<h1[^>]*>([\s\S]{0,300}?)<\/h1>/i);
            var headingText = heading ? heading[1].replace(/<[^>]+>/g, ' ') : '';
            if (!headingText) {
                var markdownHeading = page.match(/^\s*#\s+(.{2,160})$/m);
                if (markdownHeading) headingText = markdownHeading[1];
            }
            headingText = decodeEntities(
                headingText
                    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')  // images and links
                    .replace(/[\[\]]/g, ' ')
            ).replace(/\s+/g, ' ').trim();
            if (headingText.length >= 3 && headingText.length <= 120) return this.cleanTitle(headingText);

            var tag = page.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
            return tag ? this.cleanTitle(decodeEntities(tag[1])) : '';
        },

        /**
         * Strip the parts of a page headline that are not the event name.
         *   "Sharon Verma Live  Comedy Shows, Stand up Comedy, Events Events Tickets
         *    - BookMyShow"  ->  "Sharon Verma Live"
         */
        cleanTitle: function (value) {
            var title = decodeEntities(value).replace(/\s+/g, ' ').trim();

            // The site name, usually after the last separator.
            var parts = title.split(/\s+[-|–—]\s+/);
            if (parts.length > 1 && parts[parts.length - 1].split(/\s+/).length <= 5) {
                title = parts.slice(0, -1).join(' - ').trim();
            }

            // Category and ticket keywords that follow the name.
            var marketing = /,?\s*\b(?:comedy shows?|stand[\s-]?up comedy|comedy|events?|tickets?|book tickets|shows?|concerts?|plays?|movies?|sports?|activities|workshops?|festivals?|live shows?|event tickets)\b/gi;
            for (var pass = 0; pass < 4; pass++) {
                var before = title;
                title = title.replace(marketing, ' ');
                title = title.replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, '').replace(/\s{2,}/g, ' ');
                if (title === before) break;
            }

            // The name must keep some words; if the cleanup emptied it, keep the original.
            if (title.replace(/[^A-Za-z0-9]/g, '').length < 3) {
                return decodeEntities(value).replace(/\s+/g, ' ').trim();
            }
            return title;
        },

        /**
         * The venue a reader-service page reports, if it does.
         *
         * These pages put a location icon before the venue and often show the city
         * after a colon ("Sophia Bhabha Auditorium: Mumbai"). Requiring one of those
         * two marks is what stops navigation text being mistaken for a venue.
         */
        venueHint: function (text) {
            var lines = String(text || '').split('\n');
            var placeWord = /\b(?:club|hall|centre|center|theatre|theater|auditorium|arena|stadium|grounds?|park|rooms?|office|studio|gallery|museum|library|hotel|resort|restaurant|cafe|café|bar|pub|lounge|mall|convention|academy|institute|campus|school|college|university|church|temple|mosque|marina|pavilion|gardens?|palace|mill|warehouse|rooftop|banquet|amphitheatre|amphitheater|society|sabha|bhavan|bhawan|kendra|maidan)\b/i;
            // A reader service reports its own failures, and its error banner has the
            // shape of a labelled field ("Warning: Target URL returned error 404").
            var meta = /^(?:warning|error|notice|target url|url source|title|markdown content|published time)\b/i;

            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (!line || meta.test(line)) continue;
                if (line.length > 100 || line.split(/\s+/).length > 10) continue;
                if (/[:]\s*[A-Z][a-z]+$/.test(line) && placeWord.test(line)) return line;
            }

            // "Venue: X" or "Location: X" as an explicit label.
            for (var j = 0; j < lines.length; j++) {
                if (meta.test(lines[j].trim())) continue;
                var labelled = lines[j].match(/^\s*(?:venue|location|where)\s*[:\-]\s*(.+)$/i);
                if (labelled) {
                    var value = labelled[1].trim();
                    if (value && value.length <= 100 && !/\d{1,2}:\d{2}/.test(value)) return value;
                }
            }

            return '';
        },

        /* ------------------------------------------------------------------ *
         * Retrieval
         * ------------------------------------------------------------------ */

        /** fetch() with a deadline, so a hanging page cannot freeze the interface. */
        fetchText: function (url, options) {
            var opts = options || {};
            var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
            var timer = setTimeout(function () { if (controller) controller.abort(); }, opts.timeout || READ_TIMEOUT_MS);
            var request = { method: 'GET', headers: opts.headers || {} };
            if (controller) request.signal = controller.signal;

            return fetch(url, request).then(function (response) {
                if (!response.ok) {
                    var error = new Error('HTTP ' + response.status);
                    error.status = response.status;
                    throw error;
                }
                return response.text();
            }).finally(function () {
                clearTimeout(timer);
            });
        },

        /**
         * Try every route for a URL, in order of quality.
         * @param {string} url
         * @returns {Promise<object>} {ok, route, error, page}
         */
        load: function (url) {
            var target = normalizeUrl(url);
            if (!target) return Promise.resolve({ ok: false, route: '', reason: REASON.noUrl });

            var self = this;
            var readerUrl = function (raw) {
                return READER_ENDPOINT + target + (raw ? '?x-respond-with=html' : '');
            };

            // 1. Direct: gives the real HTML with JSON-LD when the site allows it.
            var direct = function () {
                return self.fetchText(target, { headers: { Accept: 'text/html,application/xhtml+xml' } })
                    .then(function (html) {
                        return { ok: true, route: 'direct', page: self.parseHtml(html) };
                    });
            };

            // 2. Reader with HTML: still gives JSON-LD, and survives sites that block
            //    browsers (this is what reaches BookMyShow).
            var readerHtml = function () {
                return self.fetchText(readerUrl(true))
                    .then(function (html) {
                        return { ok: true, route: 'reader-html', page: self.parseHtml(html) };
                    });
            };

            // 3. Reader as text: the last resort, no structured data but readable.
            var readerText = function () {
                return self.fetchText(readerUrl(false))
                    .then(function (text) {
                        var page = self.parseHtml('');
                        page.text = text;
                        page.source = 'reader-text';
                        var title = text.match(/^\s*Title:\s*(.+)$/m);
                        if (title) page.title = decodeEntities(title[1]);
                        return { ok: true, route: 'reader-text', page: page };
                    });
            };

            var note = function (error) {
                var status = error && error.status;
                return { ok: false, route: '', reason: (status === 403 || status === 401) ? REASON.blocked : REASON.offline };
            };

            return direct()
                .catch(function () { return readerHtml(); })
                .catch(function () { return readerText(); })
                .catch(function (error) { return note(error); });
        }
    };

    root.UrlFetch = UrlFetch;

    if (typeof module === 'object' && module.exports) module.exports = UrlFetch;
})(typeof globalThis !== 'undefined' ? globalThis : this);
