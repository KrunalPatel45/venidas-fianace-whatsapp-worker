
'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const readline = require('readline');

const { Client, LocalAuth } = require('whatsapp-web.js');

/*
|--------------------------------------------------------------------------
| VENIDAS FINANCE WHATSAPP WORKER
|--------------------------------------------------------------------------
| Existing Laravel API:
|
| POST /api/v1/whatsapp-worker/next
| POST /api/v1/whatsapp-worker/{notification}/sent
| POST /api/v1/whatsapp-worker/{notification}/failed
|
*/

const VERSION = 'VENIDAS-WORKER-V7-EXISTING-NEXT-API';

const API_URL = String(
    process.env.LARAVEL_API_URL || ''
).trim().replace(/\/+$/, '');

const WORKER_TOKEN = String(
    process.env.WHATSAPP_WORKER_TOKEN || ''
).trim();

const GROUP_ID = String(
    process.env.WHATSAPP_GROUP_ID || ''
).trim();

const HEADLESS =
    String(process.env.HEADLESS || 'false')
        .trim()
        .toLowerCase() === 'true';

const CHROME_PATH = String(
    process.env.CHROME_EXECUTABLE_PATH || ''
).trim();

const POLL_INTERVAL = Number(
    process.env.POLL_INTERVAL_MS || 10000
);

const AUTH_DIRECTORY = path.join(
    __dirname,
    '.wwebjs_auth'
);

const GROUPS_FILE = path.join(
    __dirname,
    'whatsapp-groups.json'
);

/*
|--------------------------------------------------------------------------
| Environment validation
|--------------------------------------------------------------------------
*/

if (!API_URL) {
    console.error('Missing LARAVEL_API_URL in .env');
    process.exit(1);
}

if (!WORKER_TOKEN) {
    console.error('Missing WHATSAPP_WORKER_TOKEN in .env');
    process.exit(1);
}

if (
    !Number.isFinite(POLL_INTERVAL) ||
    POLL_INTERVAL < 5000
) {
    console.error(
        'POLL_INTERVAL_MS must be at least 5000'
    );
    process.exit(1);
}

if (CHROME_PATH && !fs.existsSync(CHROME_PATH)) {
    console.error(
        'Chrome executable not found:',
        CHROME_PATH
    );
    process.exit(1);
}

/*
|--------------------------------------------------------------------------
| Laravel API client
|--------------------------------------------------------------------------
*/

const api = axios.create({
    baseURL: API_URL,
    timeout: 30000,
    headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Worker-Token': WORKER_TOKEN
    }
});

/*
|--------------------------------------------------------------------------
| Runtime state
|--------------------------------------------------------------------------
*/

let client = null;

let ready = false;
let stopping = false;
let processing = false;

let pollingTimer = null;

let lastAuthAt = null;
let lastReadyAt = null;

/*
|--------------------------------------------------------------------------
| Logging helpers
|--------------------------------------------------------------------------
*/

function log(...args) {
    console.log(
        `[${new Date().toISOString()}]`,
        ...args
    );
}

function logError(title, error) {
    console.error('\n========== ERROR ==========');
    console.error(title);

    console.error(
        'Message:',
        error?.message || String(error)
    );

    if (error?.response) {
        console.error(
            'HTTP:',
            error.response.status
        );

        console.error(
            'Response:',
            JSON.stringify(error.response.data)
        );
    }

    if (error?.stack) {
        console.error(error.stack);
    }

    console.error('===========================\n');
}

function errorText(error) {
    if (error?.response) {
        return JSON.stringify(
            error.response.data
        ).slice(0, 1500);
    }

    return String(
        error?.message || error
    ).slice(0, 1500);
}

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

/*
|--------------------------------------------------------------------------
| WhatsApp browser status
|--------------------------------------------------------------------------
*/

async function inspectWhatsApp() {
    if (!client?.pupPage) {
        log('WhatsApp browser page unavailable.');
        return;
    }

    try {
        const result = await client.pupPage.evaluate(() => {
            return {
                url: location.href,
                documentReady: document.readyState,
                wwebjs: typeof window.WWebJS,
                store: typeof window.Store,
                require: typeof window.require
            };
        });

        console.log('\n========== WHATSAPP STATUS ==========');

        console.log(
            JSON.stringify(
                {
                    ...result,
                    clientReady: ready,
                    lastAuthAt,
                    lastReadyAt
                },
                null,
                2
            )
        );

        console.log('=====================================\n');

    } catch (error) {
        logError(
            'Cannot inspect WhatsApp',
            error
        );
    }
}

/*
|--------------------------------------------------------------------------
| Best-effort group discovery
|--------------------------------------------------------------------------
|
| This inspects visible WhatsApp Web links only.
| WhatsApp may not expose group IDs in the DOM.
|
*/

async function listGroups() {
    if (!client?.pupPage) {
        log('WhatsApp browser unavailable.');
        return;
    }

    try {
        const groups = await client.pupPage.evaluate(() => {
            const result = [];

            const links = document.querySelectorAll(
                'a[href]'
            );

            for (const link of links) {
                const href =
                    link.getAttribute('href') || '';

                const match = href.match(
                    /([0-9]{8,}(?:-[0-9]+)?)@g\.us/
                );

                if (!match) {
                    continue;
                }

                const name = String(
                    link.getAttribute('title') ||
                    link.getAttribute('aria-label') ||
                    link.textContent?.trim() ||
                    'Unnamed Group'
                );

                result.push({
                    name: name.slice(0, 150),
                    id: match[0]
                });
            }

            return result;
        });

        const unique = new Map();

        for (const group of groups) {
            if (
                typeof group.id === 'string' &&
                group.id.endsWith('@g.us')
            ) {
                unique.set(
                    group.id,
                    group
                );
            }
        }

        const finalGroups = Array.from(
            unique.values()
        );

        fs.writeFileSync(
            GROUPS_FILE,
            JSON.stringify(
                finalGroups,
                null,
                2
            ),
            'utf8'
        );

        console.log('\n========== WHATSAPP GROUPS ==========');

        console.log(
            'Total found:',
            finalGroups.length
        );

        for (const group of finalGroups) {
            console.log('-------------------------------------');
            console.log('Name:', group.name);
            console.log('ID:', group.id);
        }

        console.log('=====================================\n');

        if (finalGroups.length === 0) {
            log(
                'No group IDs found in visible links.',
                'This does not mean your account has no groups.'
            );
        }

        log(
            'Group discovery file:',
            GROUPS_FILE
        );

    } catch (error) {
        logError(
            'Cannot list WhatsApp groups',
            error
        );
    }
}

/*
|--------------------------------------------------------------------------
| Existing Laravel /next API
|--------------------------------------------------------------------------
*/

async function nextNotification() {
    const response = await api.post(
        '/next',
        {}
    );

    const body = response.data;

    if (
        !body ||
        typeof body !== 'object'
    ) {
        throw new Error(
            'Laravel /next returned invalid JSON.'
        );
    }

    if (body.success === false) {
        throw new Error(
            'Laravel /next failed: ' +
            JSON.stringify(body)
        );
    }

    /*
     * Expected existing response:
     *
     * {
     *   success: true,
     *   data: {
     *     id: 1,
     *     message: "...",
     *     attempts: 1
     *   }
     * }
     *
     * No notification:
     * { success: true, data: null }
     */

    if (!Object.prototype.hasOwnProperty.call(body, 'data')) {
        throw new Error(
            'Laravel /next response does not contain data. ' +
            'Actual response: ' +
            JSON.stringify(body).slice(0, 1000)
        );
    }

    const notification = body.data;

    if (notification === null) {
        return null;
    }

    if (
        typeof notification !== 'object' ||
        notification.id === undefined ||
        notification.id === null ||
        typeof notification.message !== 'string'
    ) {
        throw new Error(
            'Unexpected /next notification structure: ' +
            JSON.stringify(notification).slice(0, 1000)
        );
    }

    return notification;
}

/*
|--------------------------------------------------------------------------
| Existing Laravel /sent API
|--------------------------------------------------------------------------
*/

async function markSent(notification) {
    const response = await api.post(
        `/notifications/${notification.id}/sent`,
        {
            attempts: notification.attempts
        }
    );

    if (response.data?.success === false) {
        throw new Error(
            'Laravel /sent returned failure: ' +
            JSON.stringify(response.data)
        );
    }

    return response.data;
}

/*
|--------------------------------------------------------------------------
| Existing Laravel /failed API
|--------------------------------------------------------------------------
*/

async function markFailed(notification, error) {
    const response = await api.post(
        `/notifications/${notification.id}/failed`,
        {
            attempts: notification.attempts,
            error: errorText(error)
        }
    );

    if (response.data?.success === false) {
        throw new Error(
            'Laravel /failed returned failure: ' +
            JSON.stringify(response.data)
        );
    }

    return response.data;
}

/*
|--------------------------------------------------------------------------
| Process one notification
|--------------------------------------------------------------------------
*/

async function processNotification() {
    if (
        !ready ||
        stopping ||
        processing ||
        !GROUP_ID
    ) {
        return;
    }

    processing = true;

    let notification = null;
    let sendAttempted = false;

    try {
        notification = await nextNotification();

        if (!notification) {
            return;
        }

        log(
            'Processing notification ID:',
            notification.id
        );

        if (!ready || !client) {
            throw new Error(
                'WhatsApp disconnected before sending.'
            );
        }

        if (!GROUP_ID.endsWith('@g.us')) {
            throw new Error(
                'WHATSAPP_GROUP_ID must end with @g.us'
            );
        }

        sendAttempted = true;

        const result = await client.sendMessage(
            GROUP_ID,
            notification.message
        );

        if (!result) {
            throw new Error(
                'WhatsApp returned empty message result.'
            );
        }

        await markSent(notification);

        log(
            'Notification marked SENT:',
            notification.id
        );

    } catch (error) {
        logError(
            'Notification failed',
            error
        );

        if (
            notification &&
            !sendAttempted
        ) {
            try {
                await markFailed(
                    notification,
                    error
                );
            } catch (updateError) {
                logError(
                    'Cannot mark notification failed',
                    updateError
                );
            }
        }

        if (
            notification &&
            sendAttempted
        ) {
            log(
                'WARNING: WhatsApp send was attempted.',
                'Delivery may have succeeded.',
                'Check group before retrying notification:',
                notification.id
            );
        }

    } finally {
        processing = false;
    }
}

/*
|--------------------------------------------------------------------------
| Polling
|--------------------------------------------------------------------------
*/

function startPolling() {
    if (
        pollingTimer ||
        !ready ||
        !GROUP_ID
    ) {
        if (!GROUP_ID) {
            log(
                'WHATSAPP_GROUP_ID is not configured.',
                'Polling disabled.'
            );
        }

        return;
    }

    pollingTimer = setInterval(() => {
        processNotification().catch(error => {
            logError(
                'Polling error',
                error
            );
        });
    }, POLL_INTERVAL);

    log(
        'Polling started.',
        'Interval:',
        POLL_INTERVAL,
        'ms'
    );
}

function stopPolling() {
    if (pollingTimer) {
        clearInterval(pollingTimer);
        pollingTimer = null;
    }
}

/*
|--------------------------------------------------------------------------
| WhatsApp events
|--------------------------------------------------------------------------
*/

function registerWhatsAppEvents() {
    client.on('qr', qr => {
        if (stopping) return;

        log('WhatsApp QR received.');

        qrcode.generate(
            qr,
            { small: true }
        );

        log(
            'Scan QR using WhatsApp Linked Devices.'
        );
    });

    client.on('authenticated', () => {
        if (stopping) return;

        lastAuthAt = new Date().toISOString();

        log(
            'WhatsApp authenticated successfully.'
        );

        log(
            'Waiting for WhatsApp READY event.'
        );
    });

    client.on(
        'loading_screen',
        (percent, message) => {
            if (stopping) return;

            log(
                `WhatsApp loading: ${percent}%`,
                message
            );
        }
    );

    client.on('ready', async () => {
        if (
            stopping ||
            ready
        ) {
            return;
        }

        ready = true;

        lastReadyAt = new Date().toISOString();

        log('================================');
        log('WHATSAPP CLIENT IS READY');
        log('================================');

        startPolling();

        await inspectWhatsApp();
    });

    client.on('auth_failure', message => {
        ready = false;

        stopPolling();

        logError(
            'WhatsApp authentication failed',
            new Error(String(message))
        );
    });

    client.on('disconnected', reason => {
        ready = false;

        stopPolling();

        log(
            'WhatsApp disconnected:',
            reason
        );

        log(
            'Automatic reconnect disabled.'
        );
    });

    client.on('change_state', state => {
        if (stopping) return;

        log(
            'WhatsApp connection state:',
            state
        );
    });
}

/*
|--------------------------------------------------------------------------
| Terminal commands
|--------------------------------------------------------------------------
*/

function registerTerminal() {
    const terminal = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    terminal.on('line', async input => {
        const command = input
            .trim()
            .toLowerCase();

        if (command === 'status') {
            console.log({
                version: VERSION,
                ready,
                stopping,
                processing,
                lastAuthAt,
                lastReadyAt,
                groupConfigured: Boolean(GROUP_ID)
            });

            return;
        }

        if (command === 'inspect') {
            await inspectWhatsApp();
            return;
        }

        if (command === 'groups') {
            await listGroups();
            return;
        }

        if (command === 'help') {
            console.log(
                'Commands: status, inspect, groups, help, exit'
            );
            return;
        }

        if (command === 'exit') {
            await shutdown();
        }
    });
}

/*
|--------------------------------------------------------------------------
| Shutdown
|--------------------------------------------------------------------------
*/

async function shutdown() {
    if (stopping) {
        return;
    }

    stopping = true;
    ready = false;

    stopPolling();

    log(
        'Stopping WhatsApp worker...'
    );

    let waited = 0;

    while (
        processing &&
        waited < 30000
    ) {
        await sleep(500);
        waited += 500;
    }

    if (client) {
        try {
            await client.destroy();
        } catch (error) {
            logError(
                'Browser shutdown error',
                error
            );
        }
    }

    process.exit(0);
}

/*
|--------------------------------------------------------------------------
| Main
|--------------------------------------------------------------------------
*/

async function main() {
    console.log('\n================================');
    console.log(' VENIDAS FINANCE WHATSAPP WORKER');
    console.log('================================');

    console.log(
        'VERSION:',
        VERSION
    );

    console.log(
        'FILE:',
        __filename
    );

    console.log(
        'HEADLESS:',
        HEADLESS
    );

    console.log(
        'GROUP:',
        GROUP_ID || 'Not configured'
    );

    console.log('================================\n');

    registerTerminal();

    const puppeteerOptions = {
        headless: HEADLESS,
        timeout: 120000,
        protocolTimeout: 120000,
        args: [
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-dev-shm-usage'
        ]
    };

    if (CHROME_PATH) {
        puppeteerOptions.executablePath = CHROME_PATH;
    }

    client = new Client({
        authStrategy: new LocalAuth({
            clientId: 'venidas-finance',
            dataPath: AUTH_DIRECTORY
        }),
        puppeteer: puppeteerOptions,
        authTimeoutMs: 120000,
        qrMaxRetries: 5
    });

    registerWhatsAppEvents();

    log(
        'Starting WhatsApp Web once...'
    );

    try {
        await client.initialize();

        log(
            'WhatsApp initialize() completed.'
        );

        log(
            'Waiting for READY event if not already ready.'
        );

    } catch (error) {
        logError(
            'WhatsApp initialization failed',
            error
        );
    }
}

/*
|--------------------------------------------------------------------------
| Process handlers
|--------------------------------------------------------------------------
*/

process.on(
    'SIGINT',
    shutdown
);

process.on(
    'SIGTERM',
    shutdown
);

process.on(
    'unhandledRejection',
    error => {
        logError(
            'Unhandled promise rejection',
            error
        );
    }
);

main().catch(error => {
    logError(
        'Fatal worker error',
        error
    );

    process.exitCode = 1;
});
