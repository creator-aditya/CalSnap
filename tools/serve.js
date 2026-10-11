/**
 * Zero-dependency static server for local development.
 *
 *   npm start            # http://localhost:5173
 *   node tools/serve.js 9000
 *
 * A plain static server is all CalSnap needs: the application is three scripts,
 * one stylesheet and no backend. The service worker and the Web Share API only
 * run on http://localhost or over HTTPS, which this server provides for local use.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 5173);
const HOST = '127.0.0.1';

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/manifest+json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.ics': 'text/calendar; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8'
};

const server = http.createServer((request, response) => {
    // Never serve outside the project directory.
    const requested = decodeURIComponent(new URL(request.url, `http://${HOST}:${PORT}`).pathname);
    const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
    const filePath = path.resolve(ROOT, relative);

    if (!filePath.startsWith(ROOT)) {
        response.writeHead(403).end('Forbidden');
        return;
    }

    fs.readFile(filePath, (error, data) => {
        if (error) {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Not found: ' + relative);
            return;
        }
        response.writeHead(200, {
            'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-cache'
        });
        response.end(data);
    });
});

server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        // A server from an earlier run is still up. Report it in the same shape as
        // a fresh start so the VS Code launch task is satisfied and the debugger
        // simply attaches to what is already running.
        console.log(`CalSnap is available at http://${HOST}:${PORT}/`);
        console.log('(an earlier server was already listening on this port)');
        process.exit(0);
    }
    console.error('CalSnap server error:', error.message);
    process.exit(1);
});

server.listen(PORT, HOST, () => {
    console.log(`CalSnap is available at http://${HOST}:${PORT}/`);
    console.log('Press Ctrl+C to stop.');
});
