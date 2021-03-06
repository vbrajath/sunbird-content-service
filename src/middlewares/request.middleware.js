var async = require('async');
var uuidV1 = require('uuid/v1');
var respUtil = require('response_util');
var messageUtil = require('../service/messageUtil');
var LOG = require('sb_logger_util');
var utilsService = require('../service/utilsService');
var path = require('path');
var ekStepUtil = require('sb-ekstep-util');
var ApiInterceptor = require('sb_api_interceptor');
var _ = require('underscore');
var configUtil = require('sb-config-util');

var reqMsg = messageUtil.REQUEST;
var contentMessage = messageUtil.CONTENT;
var responseCode = messageUtil.RESPONSE_CODE;
var apiVersions = messageUtil.API_VERSION;
var filename = path.basename(__filename);

var keyCloak_config = {
    "authServerUrl": process.env.sunbird_keycloak_auth_server_url ? process.env.sunbird_keycloak_auth_server_url : "https://staging.open-sunbird.org/auth",
    "realm": process.env.sunbird_keycloak_realm ? process.env.sunbird_keycloak_realm : "sunbird",
    "clientId": process.env.sunbird_keycloak_client_id ? process.env.sunbird_keycloak_client_id : "portal",
    "public": process.env.sunbird_keycloak_public ? process.env.sunbird_keycloak_public : true
};

var cache_config = {
    stroe : process.env.sunbird_cache_store ? process.env.sunbird_cache_store : "memory",
    ttl : process.env.sunbird_cache_ttl ? process.env.sunbird_cache_ttl : 1800
};

var apiInterceptor = new ApiInterceptor(keyCloak_config, cache_config);

/**
 * This function helps to validate the request body and create response body
 * this function works as a middleware which called before each api
 * @param {type} req
 * @param {type} res
 * @param {type} next
 * @returns {unresolved}
 */
function createAndValidateRequestBody(req, res, next) {

    req.body.ts = new Date();
    req.body.url = req.url;
    req.body.path = req.route.path;
    req.body.params = req.body.params ? req.body.params : {};
    req.body.params.msgid = req.headers['msgid'] || req.body.params.msgid || uuidV1();
    
    var rspObj = {
        apiId: utilsService.getAppIDForRESP(req.body.path),
        path: req.body.path,
        apiVersion: apiVersions.V1,
        msgid: req.body.params.msgid,
        result: {}
    };

    var removedHeaders = ['host', 'origin', 'accept', 'referer', 'content-length', 'user-agent', 'accept-encoding',
     'accept-language', 'accept-charset', 'cookie', 'dnt', 'postman-token', 'cache-control', 'connection'];

    removedHeaders.forEach(function(e) {
        delete req.headers[e];
    });
    
    var requestedData = {body : req.body, params: req.body.params, headers : req.headers};
    LOG.info(utilsService.getLoggerData(rspObj, "INFO", filename, "createAndValidateRequestBody", "API request come", requestedData));

    req.rspObj = rspObj;
    next();
}

/**
 * [validateToken - Used to validate the token and add userid into headers]
 * @param  {[type]}   req  
 * @param  {[type]}   res  
 * @param  {Function} next
 */
function validateToken(req, res,next) {

    var token = req.headers['x-authenticated-user-token'];
    var rspObj = req.rspObj;

    if (!token) {
        LOG.error(utilsService.getLoggerData(rspObj, "ERROR", filename, "validateToken", "API failed due to missing token"));
        rspObj.errCode = reqMsg.TOKEN.MISSING_CODE;
        rspObj.errMsg = reqMsg.TOKEN.MISSING_MESSAGE;
        rspObj.responseCode = responseCode.UNAUTHORIZED_ACCESS;
        return res.status(401).send(respUtil.errorResponse(rspObj));
    }

    apiInterceptor.validateToken(token, function(err, tokenData) {
        if(err) {
            LOG.error(utilsService.getLoggerData(rspObj, "ERROR", filename, "validateToken", "Invalid token"));
            rspObj.errCode = reqMsg.TOKEN.INVALID_CODE;
            rspObj.errMsg = reqMsg.TOKEN.INVALID_MESSAGE;
            rspObj.responseCode = responseCode.UNAUTHORIZED_ACCESS;
            return res.status(401).send(respUtil.errorResponse(rspObj));
        } else {
            delete req.headers['x-authenticated-userid'];
            delete req.headers['x-authenticated-user-token'];
            req.headers['x-authenticated-userid'] = tokenData.userId;
            req.rspObj = rspObj;
            next();
        }
    });
}

/**
 * [apiAccessForCreatorUser - Check api access for creator user]
 * @param  {[type]}   req      
 * @param  {[type]}   response 
 * @param  {Function} next        
 */
function apiAccessForCreatorUser(req, response, next) {

    var userId = req.headers['x-authenticated-userid'],
        data = {},
        rspObj = req.rspObj,
        qs = {
            fields : "createdBy"
        },
        contentMessage = messageUtil.CONTENT;

    data.contentId = req.params.contentId;

    async.waterfall([

        function(CBW) {
            
            ekStepUtil.getContentUsingQuery(data.contentId, qs, req.headers, function(err, res) {
                if (err || res.responseCode !== responseCode.SUCCESS) {
                    LOG.error(utilsService.getLoggerData(rspObj, "ERROR", filename, "apiAccessForCreatorUser", "Getting error from ekstep", res));
                    rspObj.errCode = res && res.params ? res.params.err : contentMessage.GET.FAILED_CODE;
                    rspObj.errMsg = res && res.params ? res.params.errmsg : contentMessage.GET.FAILED_MESSAGE;
                    rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR;
                    var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500;
                    return response.status(httpStatus).send(respUtil.errorResponse(rspObj));
                } else {
                    CBW(null, res);
                }
            });
        },
        function(res) {
            if(res.result.content.createdBy !== userId) {
                LOG.error(utilsService.getLoggerData(rspObj, "ERROR", filename, "apiAccessForCreatorUser", "Content createdBy and userId not matched", {createBy : res.result.content.createdBy, userId : userId}));
                rspObj.errCode = reqMsg.TOKEN.INVALID_CODE;
                rspObj.errMsg = reqMsg.TOKEN.INVALID_MESSAGE;
                rspObj.responseCode = responseCode.UNAUTHORIZED_ACCESS;
                return response.status(401).send(respUtil.errorResponse(rspObj));
            } else {
                next();
            }
        }
    ]);
}

/**
 * [apiAccessForReviewerUser - check api access for reviewer user]
 * @param  {[type]}   req      
 * @param  {[type]}   response 
 * @param  {Function} next     
 */
function apiAccessForReviewerUser(req, response, next) {

    var userId = req.headers['x-authenticated-userid'],
        data = {},
        rspObj = req.rspObj,
        qs = {
            fields : "createdBy"
        },
        contentMessage = messageUtil.CONTENT;

    data.contentId = req.params.contentId;

    async.waterfall([

        function(CBW) {
            
            ekStepUtil.getContentUsingQuery(data.contentId, qs, req.headers, function(err, res) {
                if (err || res.responseCode !== responseCode.SUCCESS) {
                    LOG.error(utilsService.getLoggerData(rspObj, "ERROR", filename, "apiAccessForReviewerUser", "Getting error from ekstep", res));
                    rspObj.errCode = res && res.params ? res.params.err : contentMessage.GET.FAILED_CODE;
                    rspObj.errMsg = res && res.params ? res.params.errmsg : contentMessage.GET.FAILED_MESSAGE;
                    rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR;
                    var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500;
                    return response.status(httpStatus).send(respUtil.errorResponse(rspObj));
                } else {
                    CBW(null, res);
                }
            });
        },
        function(res) {
            if(res.result.content.createdBy === userId) {
                LOG.error(utilsService.getLoggerData(rspObj, "ERROR", filename, "apiAccessForReviewerUser", "Content createdBy and userId are matched"));
                rspObj.errCode = reqMsg.TOKEN.INVALID_CODE;
                rspObj.errMsg = reqMsg.TOKEN.INVALID_MESSAGE;
                rspObj.responseCode = responseCode.UNAUTHORIZED_ACCESS;
                return response.status(401).send(respUtil.errorResponse(rspObj));
            } else {
                next();
            }
        }
    ]);
}

/**
 * [hierarchyUpdateApiAccess - Check api access for heirarchy update
 * @param  {[type]}   req      
 * @param  {[type]}   response 
 * @param  {Function} next        
 */
function hierarchyUpdateApiAccess(req, response, next) {

    var userId = req.headers['x-authenticated-userid'],
        data = req.body,
        rspObj = req.rspObj,
        qs = {
            fields : "createdBy"
        },
        contentMessage = messageUtil.CONTENT;

    if (!data.request || !data.request.data || !data.request.data.hierarchy) {
        LOG.error(utilsService.getLoggerData(rspObj, "ERROR", filename, "hierarchyUpdateApiAccess", "Error due to required params are missing", data.request));
        rspObj.errCode = contentMessage.HIERARCHY_UPDATE.MISSING_CODE;
        rspObj.errMsg = contentMessage.HIERARCHY_UPDATE.MISSING_MESSAGE;
        rspObj.responseCode = responseCode.CLIENT_ERROR;
        return response.status(400).send(respUtil.errorResponse(rspObj));
    }

    var hierarchy = data.request.data.hierarchy;
    data.contentId = _.findKey(hierarchy, function(item) {
                        if(item.root === true) return item;
                    });

    async.waterfall([
        function(CBW) {
            ekStepUtil.getContentUsingQuery(data.contentId, qs, req.headers, function(err, res) {
                if (err || res.responseCode !== responseCode.SUCCESS) {
                    LOG.error(utilsService.getLoggerData(rspObj, "ERROR", filename, "apiAccessForCreatorUser", "Getting error from ekstep", res));
                    rspObj.errCode = res && res.params ? res.params.err : contentMessage.GET.FAILED_CODE;
                    rspObj.errMsg = res && res.params ? res.params.errmsg : contentMessage.GET.FAILED_MESSAGE;
                    rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR;
                    var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500;
                    return response.status(httpStatus).send(respUtil.errorResponse(rspObj));
                } else {
                    CBW(null, res);
                }
            });
        },
        function(res) {
            if(res.result.content.createdBy !== userId) {
                LOG.error(utilsService.getLoggerData(rspObj, "ERROR", filename, "apiAccessForCreatorUser", "Content createdBy and userId not matched", {createBy : res.result.content.createdBy, userId : userId}));
                rspObj.errCode = reqMsg.TOKEN.INVALID_CODE;
                rspObj.errMsg = reqMsg.TOKEN.INVALID_MESSAGE;
                rspObj.responseCode = responseCode.UNAUTHORIZED_ACCESS;
                return response.status(401).send(respUtil.errorResponse(rspObj));
            } else {
                next();
            }
        }
    ]);
}

//Exports required function
module.exports.validateToken = validateToken;
module.exports.createAndValidateRequestBody = createAndValidateRequestBody;
module.exports.apiAccessForReviewerUser = apiAccessForReviewerUser;
module.exports.apiAccessForCreatorUser = apiAccessForCreatorUser;
module.exports.hierarchyUpdateApiAccess = hierarchyUpdateApiAccess;