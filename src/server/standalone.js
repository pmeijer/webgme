/*globals requireJS*/
/*jshint node:true, camelcase:false*/

/**
 * @module Server:StandAlone
 * @author kecso / https://github.com/kecso
 */

'use strict';

var Path = require('path'),
    OS = require('os'),
    Q = require('q'),
    fs = require('fs'),
    Express = require('express'),
    compression = require('compression'),
    cookieParser = require('cookie-parser'),
    bodyParser = require('body-parser'),
    methodOverride = require('method-override'),
    multipart = require('connect-multiparty'),
    Http = require('http'),
    URL = require('url'),
    ejs = requireJS('common/util/ejs'),

    MongoAdapter = require('./storage/mongo'),
    RedisAdapter = require('./storage/datastores/redisadapter'),
    MemoryAdapter = require('./storage/memory'),
    Storage = require('./storage/safestorage'),
    WebSocket = require('./storage/websocket'),

// Middleware
    BlobServer = require('./middleware/blob/BlobServer'),
    ExecutorServer = require('./middleware/executor/ExecutorServer'),
    api = require('./api'),

    getClientConfig = require('../../config/getclientconfig'),
    GMEAUTH = require('./middleware/auth/gmeauth'),
    Logger = require('./logger'),

    ServerWorkerManager = require('./worker/serverworkermanager'),

    webgmeUtils = require('../utils'),

    servers = [],

    mainLogger;


process.on('SIGINT', function () {
    var i,
        error = false,
        numStops = 0;

    function serverOnStop(server) {
        server.stop(function (err) {
            numStops -= 1;
            if (err) {
                error = true;
                server.logger.error('Stopping server failed', {metadata: err});
            } else {
                server.logger.info('Server stopped.');
            }

            if (numStops === 0) {
                if (error) {
                    exit(1);
                } else {
                    exit(0);
                }

            }
        });
    }

    for (i = 0; i < servers.length; i += 1) {
        // stop server gracefully on ctrl+C or cmd+c
        if (servers[i].isRunning) {
            servers[i].logger.info('Requesting server to stop ...');
            numStops += 1;
            serverOnStop(servers[i]);
        }
    }

    function exit(code) {
        process.exit(code);
    }

    if (numStops === 0) {
        exit(0);
    }

});

function StandAloneServer(gmeConfig) {
    var self = this,
        clientConfig = getClientConfig(gmeConfig),
        excludeRegExs = [],
        sockets = [];

    self.id = Math.random().toString(36).slice(2, 11);

    if (mainLogger) {

    } else {
        mainLogger = Logger.createWithGmeConfig('gme', gmeConfig, true);
    }

    this.serverUrl = '';
    this.isRunning = false;

    servers.push(this);

    /**
     * Gets the server's url based on the gmeConfig that was given to the constructor.
     * @returns {string}
     */
    function getUrl() {
        var url = '';

        // use the cached version if we already built the string
        if (self.serverUrl) {
            return self.serverUrl;
        }

        url = 'http://127.0.0.1:' + gmeConfig.server.port;

        // cache it
        self.serverUrl = url;
        return self.serverUrl;
    }

    //public functions
    function start(callback) {
        var serverDeferred = Q.defer(),
            storageDeferred = Q.defer(),
            svgDeferred = Q.defer(),
            gmeAuthDeferred = Q.defer(),
            executorDeferred = Q.defer();

        if (typeof callback !== 'function') {
            callback = function () {
            };
        }

        if (self.isRunning) {
            // FIXME: should this be an error?
            callback();
            return;
        }

        if (gmeConfig.visualization.svgDirs.length > 0) {
            svgDeferred = webgmeUtils.copySvgDirsAndRegenerateSVGList(gmeConfig, logger);
        } else {
            svgDeferred.resolve();
        }

        sockets = {};


        __httpServer = Http.createServer(__app);

        function handleNewConnection(socket) {
            var socketId = socket.remoteAddress + ':' + socket.remotePort;

            if (socket.encrypted) { // https://nodejs.org/api/tls.html#tls_tlssocket_encrypted
                socketId += ':encrypted';
            }

            sockets[socketId] = socket;
            logger.debug('socket connected (added to list) ' + socketId);

            socket.on('close', function () {
                if (sockets.hasOwnProperty(socketId)) {
                    logger.debug('socket closed (removed from list) ' + socketId);
                    delete sockets[socketId];
                }
            });
        }

        __httpServer.on('connection', handleNewConnection);
        __httpServer.on('secureConnection', handleNewConnection);

        __httpServer.on('clientError', function (err, socket) {
            logger.debug('clientError', err);
        });


        __httpServer.on('error', function (err) {
            if (err.code === 'EADDRINUSE') {
                logger.error('Failed to start server', {metadata: {port: gmeConfig.server.port, error: err}});
                serverDeferred.reject(err);
            } else {
                logger.error('Server raised an error', {metadata: {port: gmeConfig.server.port, error: err}});
            }
        });

        __httpServer.listen(gmeConfig.server.port, function () {
            // Note: the listening function does not return with an error, errors are handled by the error event
            logger.debug('Http server is listening on ', {metadata: {port: gmeConfig.server.port}});
            serverDeferred.resolve();
        });

        __storage.openDatabase(function (err) {
            if (err) {
                storageDeferred.reject(err);
            } else {
                __webSocket.start(__httpServer);
                storageDeferred.resolve();
            }
        });

        __gmeAuth.connect(function (err, db) {
            if (err) {
                logger.error(err);
                gmeAuthDeferred.reject(err);
            } else {
                logger.debug('gmeAuth is ready');
                gmeAuthDeferred.resolve();
                if (__executorServer) {
                    __executorServer.start({mongoClient: db}, function (err) {
                        if (err) {
                            executorDeferred.reject(err);
                        } else {
                            executorDeferred.resolve();
                        }
                    });
                } else {
                    executorDeferred.resolve();
                }
            }
        });

        __workerManager.start();

        Q.all([
            svgDeferred.promise,
            serverDeferred.promise,
            storageDeferred.promise,
            gmeAuthDeferred.promise,
            apiReady,
            executorDeferred.promise
        ])
            .nodeify(function (err) {
                self.isRunning = true;
                callback(err);
            });
    }

    function stop(callback) {
        var key;

        if (self.isRunning === false) {
            // FIXME: should this be an error?
            callback();
            return;
        }

        self.isRunning = false;

        try {
            if (__executorServer) {
                __executorServer.stop();
            }
            // FIXME: is this call synchronous?
            __webSocket.stop();
            //kill all remaining workers
            __workerManager.stop(function (err) {
                var numDestroyedSockets = 0;
                // close storage
                __storage.closeDatabase(function (err1) {
                    __gmeAuth.unload(function (err2) {
                        logger.debug('gmeAuth unloaded');
                        // request server close - do not accept any new connections.
                        // first we have to request the close then we can destroy the sockets.
                        __httpServer.close(function (err3) {
                            logger.info('http server closed');
                            logger.debug('http server closed');
                            callback(err || err1 || err2 || err3 || null);
                        });

                        // destroy all open sockets i.e. keep-alive and socket-io connections, etc.
                        for (key in sockets) {
                            if (sockets.hasOwnProperty(key)) {
                                sockets[key].destroy();
                                delete sockets[key];
                                logger.debug('destroyed open socket ' + key);
                                numDestroyedSockets += 1;
                            }
                        }

                        logger.debug('destroyed # of sockets: ' + numDestroyedSockets);
                    });
                });
            });
        } catch (e) {
            //ignore errors
            callback(e);
        }
    }

    this.start = start;
    this.stop = stop;


    //internal functions
    function redirectUrl(req, res) {
        if (req.query.redirect) {
            //res.redirect(URL.removeSpecialChars(req.query.redirect));
            res.redirect(decodeURIComponent(req.query.redirect));
        } else {
            res.redirect('/');
        }
    }

    function getUserId(req) {
        return req.userData.userId;
    }

    function ensureAuthenticated(req, res, next) {
        var authorization = req.get('Authorization'),
            username,
            password,
            token,
            split;

        if (gmeConfig.authentication.enable === false) {
            // If authentication is turned off we treat everybody as a guest user.
            req.userData = {
                userId: gmeConfig.authentication.guestAccount
            };
            next();
            return;
        }

        if (authorization && authorization.indexOf('Basic ') === 0) {
            logger.debug('Basic authentication request');
            // FIXME: ':' should not be in username nor in password
            split = new Buffer(authorization.substr('Basic '.length), 'base64').toString('utf8').split(':');
            username = split[0];
            password = split[1];
            if (username && password) {
                __gmeAuth.authenticateUser(username, password)
                    .then(function () {
                        req.userData = {
                            userId: username
                        };
                        next();
                    })
                    .catch(function (err) {
                        logger.debug('Basic auth failed', {metadata: err});
                        res.status(401);
                        next(new Error('Basic authentication failed'));
                    });
            } else {
                res.status(401);
                next(new Error('Basic authentication failed'));
            }
        } else if (authorization && authorization.indexOf('Bearer ') === 0) {
            logger.debug('Token Bearer authentication request');
            token = authorization.substr('Bearer '.length);
            __gmeAuth.verifyJWToken(token)
                .then(function (result) {
                    if (result.renew === true) {
                        __gmeAuth.regenerateJWToken(token)
                            .then(function (newToken) {
                                req.userData = {
                                    token: newToken,
                                    newToken: true,
                                    userId: result.content.userId
                                };

                                // TODO: Is this the correct way of doing it?
                                res.header(gmeConfig.authentication.jwt.cookieId, newToken);
                                next();
                            })
                            .catch(next);
                    } else {
                        req.userData = {
                            token: token,
                            userId: result.content.userId
                        };
                        next();
                    }
                })
                .catch(function (err) {
                    if (err.name === 'TokenExpiredError') {
                        if (res.getHeader('X-WebGME-Media-Type')) {
                            res.status(401);
                            next(err);
                        } else {
                            res.redirect('/login');
                        }
                    } else {
                        logger.debug('Cookie verification failed', {metadata: err});
                        res.status(401);
                        next(err);
                    }
                });
        } else if (req.cookies[gmeConfig.authentication.jwt.cookieId]) {
            logger.debug('jwtoken provided in cookie');
            token = req.cookies[gmeConfig.authentication.jwt.cookieId];
            __gmeAuth.verifyJWToken(token)
                .then(function (result) {
                    if (result.renew === true) {
                        __gmeAuth.regenerateJWToken(token)
                            .then(function (newToken) {
                                req.userData = {
                                    token: newToken,
                                    newToken: true,
                                    userId: result.content.userId
                                };
                                logger.debug('generated new token for user', result.content.userId);
                                res.cookie(gmeConfig.authentication.jwt.cookieId, newToken);
                                // Status code for new token??
                                next();
                            })
                            .catch(next);
                    } else {
                        req.userData = {
                            token: token,
                            userId: result.content.userId
                        };
                        next();
                    }
                })
                .catch(function (err) {
                    if (err.name === 'TokenExpiredError') {
                        res.clearCookie(gmeConfig.authentication.jwt.cookieId);
                        if (res.getHeader('X-WebGME-Media-Type')) {
                            res.status(401);
                            next(err);
                        } else {
                            res.redirect('/login');
                        }
                    } else {
                        logger.debug('Cookie verification failed', err);
                        res.status(401);
                        next(err);
                    }
                });
        } else if (gmeConfig.authentication.allowGuests) {
            logger.debug('jwtoken not provided in cookie - will generate a guest token.');
            __gmeAuth.generateJWToken(gmeConfig.authentication.guestAccount, null)
                .then(function (guestToken) {
                    req.userData = {
                        token: guestToken,
                        newToken: true,
                        userId: gmeConfig.authentication.guestAccount
                    };

                    res.cookie(gmeConfig.authentication.jwt.cookieId, guestToken);
                    next();
                })
                .catch(next);
        } else if (res.getHeader('X-WebGME-Media-Type')) {
            // do not redirect with direct api access
            res.status(401);
            return next(new Error());
        } else {
            res.redirect('/login' + webgmeUtils.getRedirectUrlParameter(req));
        }
    }

    function setupExternalRestModules() {
        var restComponent,
            keys = Object.keys(gmeConfig.rest.components),
            i;
        logger.debug('initializing external REST modules');
        for (i = 0; i < keys.length; i++) {
            restComponent = require(gmeConfig.rest.components[keys[i]]);
            if (restComponent) {
                logger.debug('adding rest component [' + gmeConfig.rest.components[keys[i]] + '] to' +
                    ' - /rest/external/' + keys[i]);
                if (restComponent.hasOwnProperty('initialize') && restComponent.hasOwnProperty('router')) {
                    // FIXME: initialize may return with a promise
                    restComponent.initialize(middlewareOpts);
                    __app.use('/rest/external/' + keys[i], restComponent.router);
                } else {
                    __app.use('/rest/external/' + keys[i], restComponent(gmeConfig, ensureAuthenticated, logger));
                }
            } else {
                throw new Error('Loading rest component ' + gmeConfig.rest.components[keys[i]] + ' failed.');
            }
        }
    }

    //here starts the main part
    //variables
    var logger = null,
        __storage = null,
        __database = null,
        __webSocket = null,
        __gmeAuth = null,
        apiReady,
        __app = null,
        __workerManager,
        __httpServer = null,
        __logoutUrl = gmeConfig.authentication.logOutUrl || '/',
        __baseDir = requireJS.s.contexts._.config.baseUrl,// TODO: this is ugly
        __clientBaseDir = Path.resolve(gmeConfig.client.appDir),
        __requestCounter = 0,
        __reportedRequestCounter = 0,
        __requestCheckInterval = 2500,
        __executorServer,
        middlewareOpts;

    //creating the logger
    logger = mainLogger.fork('server:standalone');
    self.logger = logger;

    logger.debug('starting standalone server initialization');
    //initializing https extra infos

    //logger.debug('initializing session storage');
    //__sessionStore = new SSTORE(logger, gmeConfig);

    logger.debug('initializing server worker manager');
    __workerManager = new ServerWorkerManager({
        //sessionToUser: __sessionStore.getSessionUser,
        globConf: gmeConfig,
        logger: logger
    });

    logger.debug('initializing authentication modules');
    //TODO: do we need to create this even though authentication is disabled?
    // FIXME: we need to connect with gmeAUTH again! start/stop/start/stop
    __gmeAuth = new GMEAUTH(null, gmeConfig);

    logger.debug('initializing static server');
    __app = new Express();

    if (gmeConfig.storage.database.type.toLowerCase() === 'mongo') {
        __database = new MongoAdapter(logger, gmeConfig);
    } else if (gmeConfig.storage.database.type.toLowerCase() === 'redis') {
        __database = new RedisAdapter(logger, gmeConfig);
    } else if (gmeConfig.storage.database.type.toLowerCase() === 'memory') {
        __database = new MemoryAdapter(logger, gmeConfig);
    } else {
        logger.error(new Error('Unknown storage.database.type in config (config validator not used?)',
            gmeConfig.storage.database.type));
    }

    __storage = new Storage(__database, logger, gmeConfig, __gmeAuth);
    __webSocket = new WebSocket(__storage, logger, gmeConfig, __gmeAuth, __workerManager);

    middlewareOpts = {  //TODO: Pass this to every middleware They must not modify the options!
        gmeConfig: gmeConfig,
        logger: logger,
        ensureAuthenticated: ensureAuthenticated,
        getUserId: getUserId,
        gmeAuth: __gmeAuth,
        safeStorage: __storage,
        workerManager: __workerManager
    };

    //__app.configure(function () {
    //counting of requests works only in debug mode
    if (gmeConfig.debug === true) {
        setInterval(function () {
            if (__reportedRequestCounter !== __requestCounter) {
                __reportedRequestCounter = __requestCounter;
                logger.debug('...handled ' + __reportedRequestCounter + ' requests so far...');
            }
        }, __requestCheckInterval);
        __app.use(function (req, res, next) {
            __requestCounter++;
            next();
        });
    }

    __app.use(compression());
    __app.use(cookieParser());
    __app.use(bodyParser.json());
    __app.use(bodyParser.urlencoded({
        extended: true
    }));
    __app.use(methodOverride());
    __app.use(multipart({defer: true})); // required to upload files. (body parser should not be used!)

    if (gmeConfig.executor.enable) {
        __executorServer = new ExecutorServer(middlewareOpts);
        __app.use('/rest/executor', __executorServer.router);
    } else {
        logger.debug('Executor not enabled. Add \'executor.enable: true\' to configuration to activate.');
    }

    setupExternalRestModules();

    __app.get(['', '/', '/index.html'], ensureAuthenticated, function (req, res) {
        var indexHtmlPath = Path.join(__clientBaseDir, 'index.html'),
            protocol = gmeConfig.server.behindSecureProxy ? 'https' : 'http',
            host = protocol + '://' + req.get('host'),
            url = host + req.originalUrl,
            imageUrl = host + '/img/gme-logo.png',
            projectId = req.query.project;

        logger.debug('resolved url', url);

        fs.readFile(indexHtmlPath, 'utf8', function (err, indexTemp) {
            if (err) {
                logger.error(err);
                res.send(404);
            } else {
                res.contentType('text/html');
                res.send(ejs.render(indexTemp, {
                    url: url,
                    imageUrl: imageUrl,
                    projectId: projectId ? projectId.replace('+', '/') : 'WebGME'
                }));
            }
        });
    });

    logger.debug('creating login routing rules for the static server');
    //__app.get('/', ensureAuthenticated, Express.static(__clientBaseDir));
    __app.get('/logout', function (req, res) {
        res.clearCookie(gmeConfig.authentication.jwt.cookieId);
        res.redirect(__logoutUrl);
    });

    __app.get('/login', Express.static(__clientBaseDir, {extensions: ['html'], index: false}));

    __app.post('/login', function (req, res, next) {
            var queryParams = [],
                url = URL.parse(req.url, true);
            if (req.body && req.body.username) {
                queryParams.push('username=' + encodeURIComponent(req.body.username));
            }
            if (url && url.query && url.query.redirect) {
                queryParams.push('redirect=' + encodeURIComponent(req.query.redirect));
            }
            req.__gmeAuthFailUrl__ = '/login';
            if (queryParams.length) {
                req.__gmeAuthFailUrl__ += '?' + queryParams.join('&');
            }
            req.__gmeAuthFailUrl__ += '#failed';
            next();
        },
        function (req, res, next) {
            var userId = req.body.username,
                password = req.body.password;
            if (gmeConfig.authentication.enable) {
                __gmeAuth.generateJWToken(userId, password)
                    .then(function (token) {
                        res.cookie(gmeConfig.authentication.jwt.cookieId, token);
                        redirectUrl(req, res);
                    })
                    .catch(function (err) {
                        if (res.getHeader('X-WebGME-Media-Type')) {
                            // do not redirect for api requests
                            res.status(401);
                            return next(new Error(err));
                        } else {
                            res.redirect(req.__gmeAuthFailUrl__);
                        }
                    });
            } else {
                redirectUrl(req, res);
            }
        });

    // TODO: review/revisit this part when google authentication is used.
    //__app.get('/login/google', checkGoogleAuthentication, Passport.authenticate('google'));
    //__app.get('/login/google/return', __gmeAuth.authenticate, function (req, res) {
    //    res.cookie('webgme', req.session.udmId);
    //    redirectUrl(req, res);
    //});

    //TODO: only node_worker/index.html and common/util/common are using this
    //logger.debug('creating decorator specific routing rules');
    __app.get('/bin/getconfig.js', ensureAuthenticated, function (req, res) {
        res.status(200);
        res.setHeader('Content-type', 'application/javascript');
        res.end('define([],function(){ return ' + JSON.stringify(clientConfig) + ';});');
    });

    logger.debug('creating gmeConfig.json specific routing rules');
    __app.get('/gmeConfig.json', ensureAuthenticated, function (req, res) {
        res.status(200);
        res.setHeader('Content-type', 'application/json');
        res.end(JSON.stringify(clientConfig));
    });

    logger.debug('creating decorator specific routing rules');
    __app.get(/^\/decorators\/.*/, ensureAuthenticated, function (req, res) {
        var tryNext = function (index) {
            var resolvedPath;
            if (index < gmeConfig.visualization.decoratorPaths.length) {
                resolvedPath = Path.resolve(gmeConfig.visualization.decoratorPaths[index]);
                resolvedPath = Path.join(resolvedPath, req.url.substring('/decorators/'.length));
                res.sendFile(resolvedPath, function (err) {
                    logger.debug('sending decorator', resolvedPath);
                    if (err && err.code !== 'ECONNRESET') {
                        tryNext(index + 1);
                    }
                });
            } else {
                res.sendStatus(404);
            }
        };

        if (gmeConfig.visualization.decoratorPaths && gmeConfig.visualization.decoratorPaths.length) {
            tryNext(0);
        } else {
            res.sendStatus(404);
        }
    });

    // Plugin paths
    logger.debug('creating plugin specific routing rules');
    __app.get(/^\/plugin\/.*/, webgmeUtils.getGoodExtraAssetRouteFor('plugin',
        gmeConfig.plugin.basePaths, logger, __baseDir));

    // Layout paths
    logger.debug('creating layout specific routing rules');
    __app.get(/^\/layout\/.*/, webgmeUtils.getGoodExtraAssetRouteFor('layout',
        gmeConfig.visualization.layout.basePaths, logger, __baseDir));

    // Panel paths
    logger.debug('creating path specific routing rules');
    __app.get(/^\/panel\/.*/, webgmeUtils.getRouteFor('panel', gmeConfig.visualization.panelPaths, __baseDir));

    logger.debug('creating external library specific routing rules');
    gmeConfig.server.extlibExcludes.forEach(function (regExStr) {
        logger.debug('Adding exclude rule to "/extlib" path: ', regExStr);
        excludeRegExs.push(new RegExp(regExStr));
    });

    __app.get(/^\/extlib\/.*/, ensureAuthenticated, function (req, res) {
        var i;
        for (i = 0; i < excludeRegExs.length; i += 1) {
            if (excludeRegExs[i].test(req.url)) {
                logger.warn('Request attempted to access excluded path "' + req.url + '", caught by "' +
                    gmeConfig.server.extlibExcludes[i] + '" from gmeConfig.');
                res.sendStatus(403);
                return;
            }
        }

        //first we try to give back the common extlib/modules
        var urlArray = req.path.split('/');
        urlArray[1] = '.';
        urlArray.shift();

        var relPath = urlArray.join('/');
        var absPath = Path.resolve(Path.join(process.cwd(), relPath));
        // must pass the full path
        if (relPath.lastIndexOf('/') === relPath.length - 1) {
            // if URL ends with /, append / to support sending index.html
            absPath = absPath + '/';
        }

        webgmeUtils.expressFileSending(res, absPath, logger);
    });

    logger.debug('creating basic static content related routing rules');
    //static contents
    //javascripts - core and transportation related files //TODO: remove config, middleware and bin
    __app.get(/^\/(common|config|bin|middleware)\/.*\.js$/, Express.static(__baseDir, {index: false}));
    __app.get(/^\/(dist)\/.*\.(js|css|map)$/, Express.static(Path.join(__baseDir, '..'), {index: false}));

    //TODO remove this part as this is only temporary!!!
    __app.get('/docs/*', Express.static(Path.join(__baseDir, '..'), {index: false}));

    __app.use('/rest/blob', BlobServer.createExpressBlob(middlewareOpts));

    //client contents - js/html/css
    __app.get(/^\/.*\.(css|ico|ttf|woff|woff2|js|cur)$/, Express.static(__clientBaseDir));


    __app.get('/package.json', ensureAuthenticated, Express.static(Path.join(__baseDir, '..')));
    __app.get(/^\/.*\.(_js|html|gif|png|bmp|svg|json|map)$/, ensureAuthenticated, Express.static(__clientBaseDir));

    logger.debug('creating API related routing rules');

    apiReady = api.createAPI(__app, '/api', middlewareOpts);

    // everything else is 404
    logger.debug('creating all other request rule - error 404 -');
    __app.use('*', function (req, res) {
        res.sendStatus(404);
    });

    // catches all next(new Error()) from previous rules, you can set res.status() before you call next(new Error())
    __app.use(function (err, req, res, next) {
        if (res.statusCode === 200) {
            res.status(err.status || 500);
        }
        res.sendStatus(res.statusCode);
        //res.send(err.stack ? err.stack : err); // FIXME: in dev mode
    });

    logger.debug('gmeConfig of webgme server', {metadata: gmeConfig});
    var networkIfs = OS.networkInterfaces(),
        addresses = 'Valid addresses of gme web server: ',
        forEveryNetIf = function (netIf) {
            if (netIf.family === 'IPv4') {
                var address = 'http' + '://' +
                    netIf.address + ':' + gmeConfig.server.port;
                addresses = addresses + '  ' + address;
            }
        };
    for (var dev in networkIfs) {
        networkIfs[dev].forEach(forEveryNetIf);
    }

    logger.info(addresses);

    logger.debug('standalone server initialization completed');

    return {
        getUrl: getUrl,
        start: start,
        stop: stop
    };
}

module.exports = StandAloneServer;
