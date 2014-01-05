var http = require('http');
var fs = require('fs');
var WebSocketServer = require('ws').Server;
var urlLib = require('url');
var chalk = require('chalk');

/**
  * Internal APIs
  */
var _Requester = require('./_Requester');
var _Responder = require('./_Responder');
var _ProxyRequest = require('./_ProxyRequest');
var _PromiseFactory = require('./_PromiseFactory');
// Messenger is a singleton given to all ServiceWorkers for to postMessage it up.
var _Messenger = require('./_Messenger');
var _messenger = new _Messenger();

/**
 * DOM APIs
 */
var ServiceWorker = require('./ServiceWorker');

var Promise = require('Promise');

var AsyncMap = require('./AsyncMap');
var CacheList = require('./CacheList');
var CacheItemList = require('./CacheItemList');
var Cache = require('./Cache');

var fetch = require('./fetch');

var Response = require('./Response');
var SameOriginResponse = require('./SameOriginResponse');
var Request = require('./Request');

var Event = require('./Event');
var InstallEvent = require('./InstallEvent');
var FetchEvent = require('./FetchEvent');
var ActivateEvent = require('./ActivateEvent');
var MessageEvent = require('./MessageEvent');

var fakeConsole = Object.getOwnPropertyNames(console).reduce(function (memo, method) {
    memo[method] = console[method];
    if (typeof console[method] === "function") {
        memo[method] = memo[method].bind(console, 'sw:');
    }
    return memo;
}, {});

/**
 * Config
 */

// Setup the _Requester with our config
var origin = process.argv[3];
var networkBase = process.argv[4];
_Requester.origin = origin;
_Requester.host = urlLib.parse(networkBase).host;
_Requester.networkBase = networkBase;

/**
 * Worker creation & install
 */

var currentWorkerData = {
    worker: null,
    content: '',
    isNew: false,
    isUpgrade: false
};

var newWorkerData = {
    isWaiting: false,
    installPromise: _PromiseFactory.ResolvedPromise()
};

function reloadWorker() {
    var newWorkerFile = readWorker();
    if (newWorkerFile === currentWorkerData.content) {
        return console.log(chalk.blue('Identical workers.'));
    }

    try {
        var newWorkerData = setupWorker(newWorkerFile);
    } catch (e) {
        console.error(chalk.red('Loading worker failed.'));
        console.error(e.stack);
        return;
    }
    newWorkerData.isWaiting = true;
    // FIXME: this should timeout
    newWorkerData.installPromise = installWorker(newWorkerData);
    nextWorkerData = newWorkerData;
}

function setupWorker(workerFile) {
    var worker = new ServiceWorker(_messenger);
    var workerFn = new Function(
        'AsyncMap', 'CacheList', 'CacheItemList', 'Cache',
        'Event', 'InstallEvent', 'ActivateEvent', 'FetchEvent', 'MessageEvent',
        'Response', 'SameOriginResponse',
        'Request',
        'fetch',
        'Promise',
        'console', // teehee
        workerFile
    );
    workerFn.call(
        worker,
        AsyncMap, CacheList, CacheItemList, Cache,
        Event, InstallEvent, ActivateEvent, FetchEvent, MessageEvent,
        Response, SameOriginResponse,
        Request,
        fetch,
        Promise,
        fakeConsole
    );
    return {
        worker: worker,
        content: workerFile
    };
}

// FIXME: can this fulfillment pattern be abstracted?
//          answer: yes, make the promise inside PromiseEvent and add methods
//          to force resolve/reject. Or something.
function installWorker(workerData) {
    console.log('Installing...');
    return new Promise(function (resolve, reject) {
        // Install it
        var installEvent = new InstallEvent(resolve, reject);
        workerData.worker.dispatchEvent(installEvent);
        if (!installEvent._isStopped()) {
            return resolve();
        }
    }).then(function (result) {
        console.log(chalk.green('Installed worker version:'), chalk.yellow(workerData.worker.version));
        workerData.isInstalled = true;
        return result;
    });
}

function activateWorker(workerData) {
    console.log('Activating...');
    var activatePromise = new Promise(function (resolve, reject) {
        // Activate it
        var activateEvent = new ActivateEvent(resolve, reject);
        workerData.worker.dispatchEvent(activateEvent);
        if (!activateEvent._isStopped()) {
            return resolve();
        }
    });
    activatePromise.then(function (result) {
        workerData.isWaiting = false;
        console.log(chalk.green('Activated worker version:'), chalk.yellow(workerData.worker.version));
    });
    return activatePromise;
}

/**
 * This function (of type Function) takes no arguments. DO NOT TOUCH it is
 * auto-generated by an AbstractProxyWorkerSwapperFactoryFactoryBean; and
 * it utilizes advanced NodeScript ES7 methodologies.
 */
function swapWorkers() {
    return (currentWorkerData = nextWorkerData);
}

function activateNextWorker() {
    if (nextWorkerData.isWaiting) {
        nextWorkerData.activatePromise = activateWorker(nextWorkerData);
        return nextWorkerData.activatePromise.then(swapWorkers);
    }
}

/**
 * Go, go, go.
 */

// Watch the worker
fs.watch(process.argv[5], function (type) {
    if (type !== "change") return;
    console.log();
    console.log();
    console.log(chalk.blue('Worker file changed!'));
    reloadWorker();
});

reloadWorker();

// Hacky, hacky, hacky :)
var requestIsNavigate = false;

// Create the server (proxy-ish)
var server = http.createServer(function (_request, _response) {
    // Fuck favicons, man.
    if (_request.url.match(/favicon/)) {
        return _response.end();
    }

    console.log();
    console.log();

    console.log('== REQUEST ========================================== !! ====');
    console.log(_request.url);
    // _request.url = _request.url.replace(/^\//, '');
    console.log('requestIsNavigate', requestIsNavigate);
    // console.log('===================================================== !! ====');

    // Setup the request
    var request = new _ProxyRequest(_request);
    var _responder = new _Responder(_request, _response, requestIsNavigate);
    var fetchEvent = new FetchEvent(request, _responder);
    requestIsNavigate = false;

    var readyPromise = _PromiseFactory.ResolvedPromise();
    // If this is a navigate, we can activate the next worker.
    // This may not actually do any swapping if the worker is not waiting, having
    // been installed and activated.
    if (fetchEvent.type === 'navigate') {
        readyPromise = nextWorkerData.installPromise.then(activateNextWorker);
    }

    readyPromise.then(function () {
        // Whatever happens above, we should now have an installed, activated worker
        currentWorkerData.worker.dispatchEvent(fetchEvent);
        // If the worker has not called respondWith, we should go to network.
        if (!fetchEvent._isStopped()) {
            _responder.respondWithNetwork();
        }
    }, function (why) {
        console.error(chalk.red('ready error'), why);
        return _responder.respondWithNetwork();
    });
}).listen(process.argv[2], function () {
    console.log('ServiceWorker server up at http://%s:%d', this.address().address, this.address().port);
});

/**
 * WebSocket comes from devtools extension.
 * It uses beforeunload events to notify the service worker when events
 * are navigations.
 */
var wss = new WebSocketServer({ server: server });
// TODO only accept one connection per page
wss.on('connection', function (ws) {
    console.log('ws: connection');
    // Inform the _messenger of the new socket.
    _messenger.add(ws);
    // Listen up!
    ws.on('message', function (message) {
        var data = JSON.parse(message);
        if (data.type === 'navigate') {
            return requestIsNavigate = true;
        }
        if (data.type === 'postMessage') {
            console.log('postMessage in:', data);
            var messageEvent = new MessageEvent(data.data);
            // We can only message an activated worker
            if (!currentWorkerData.activatePromise) return;
            currentWorkerData.activatePromise.then(function () {
                currentWorkerData.worker.dispatchEvent(messageEvent);
            });
        }
    });
    ws.on('close', function (message) {
        console.log('ws: close');
        _messenger.remove(ws);
    });
});

/**
 * Utils
 */

function readWorker() {
    return fs.readFileSync(process.argv[5], { encoding: 'utf-8' });
}