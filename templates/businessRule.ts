/**
 * Business Rule Template Generator
 *
 * Generates the JavaScript code that runs in ServiceNow when a catalog item
 * is requested. The script extracts variables from the request and POSTs
 * to the Flows block endpoint.
 */

export interface BusinessRuleTemplateParams {
  catalogItemName: string;
  restMessageName: string;
  restMessageFnName: string;
}

/**
 * Generates the business rule script for ServiceNow
 */
export function generateBusinessRuleScript(
  params: BusinessRuleTemplateParams,
): string {
  return `// Spacelift Flows Integration - Auto-generated Business Rule
// Catalog Item: ${params.catalogItemName}
// Generated: ${new Date().toISOString()}

(function executeRule(current, previous) {
  'use strict';

  var REST_MESSAGE_NAME = '${params.restMessageName}';
  var REST_MESSAGE_FN_NAME = '${params.restMessageFnName}';

  var FAILED_STATE = 4;

  /**
   * Logs informational message
   */
  function logInfo(message) {
    gs.info('[Spacelift Flows] ${params.catalogItemName}: ' + message);
  }

  /**
   * Logs warning message
   */
  function logWarn(message) {
    gs.warn('[Spacelift Flows] ${params.catalogItemName}: ' + message);
  }

  /**
   * Logs error message
   */
  function logError(message) {
    gs.error('[Spacelift Flows] ${params.catalogItemName}: ' + message);
  }

  /**
   * Extracts all variables from the request item
   */
  function extractVariables(requestItem) {
    var variables = {};

    try {
      for (var key in requestItem.variables) {
        try {
          var value = requestItem.variables[key];
          // Convert to string, handling null/undefined
          variables[key] = (value != null) ? value.toString() : '';
        } catch (e) {
          logWarn('Failed to extract variable: ' + key + ' - ' + e.message);
          variables[key] = '';
        }
      }
    } catch (e) {
      logError('Failed to extract variables: ' + e.message);
    }

    return variables;
  }

  /**
   * Gets metadata about the request
   */
  function getRequestMetadata(requestItem) {
    var metadata = {
      requestItemId: requestItem.sys_id.toString(),
      requestId: requestItem.request.toString(),
      requestNumber: requestItem.number.toString(),
      catalogItemName: '${params.catalogItemName}',
      requestedFor: '',
      requestedBy: '',
      requestedDate: requestItem.sys_created_on.toString(),
      quantity: requestItem.quantity ? requestItem.quantity.toString() : '1'
    };

    try {
      if (requestItem.request && requestItem.request.requested_for) {
        metadata.requestedFor = requestItem.request.requested_for.user_name.toString();
      }
    } catch (e) {
      logWarn('Failed to get requested_for: ' + e.message);
    }

    try {
      if (requestItem.request && requestItem.request.requested_by) {
        metadata.requestedBy = requestItem.request.requested_by.user_name.toString();
      }
    } catch (e) {
      logWarn('Failed to get requested_by: ' + e.message);
    }

    return metadata;
  }

  /**
   * Calls the Flows endpoint with the request data using REST Message
   */
  function callFlowsEndpoint(payload) {
    try {
      // Use the configured REST Message with stored credentials
      var request = new sn_ws.RESTMessageV2(REST_MESSAGE_NAME, REST_MESSAGE_FN_NAME);

      // Set the request body
      var body = JSON.stringify(payload);
      request.setRequestBody(body);

      logInfo('Calling Flows endpoint with payload: ' + body);

      var response = request.execute();
      var statusCode = response.getStatusCode();
      var responseBody = response.getBody();

      logInfo('Flows response - Status: ' + statusCode + ', Body: ' + responseBody);

      return {
        success: statusCode >= 200 && statusCode < 300,
        statusCode: statusCode,
        body: responseBody
      };
    } catch (e) {
      logError('Failed to call Flows endpoint: ' + e);
      return {
        success: false,
        error: String(e)
      };
    }
  }

  /**
   * Updates the request item with the result
   */
  function updateRequestItem(requestItem, success, message) {
    try {
      if (success) {
        // Don't update the request item on success
        // Flows will update it via API with proper authentication context
        logInfo('Request successfully submitted to Flows');
      } else {
        // Only update on failure - if Flows endpoint is unreachable
        requestItem.state = FAILED_STATE;
        requestItem.comments = 'Failed to submit request to Spacelift Flows: ' + message;
        requestItem.work_notes = 'Error details: ' + message;
        requestItem.update();
      }
    } catch (e) {
      logError('Failed to update request item: ' + e.message);
    }
  }

  // Main execution
  try {
    logInfo('Processing catalog item request');

    // Extract variables and metadata
    var variables = extractVariables(current);
    var metadata = getRequestMetadata(current);

    logInfo('Extracted ' + Object.keys(variables).length + ' variables');

    // Build payload
    var payload = {
      variables: variables,
      metadata: metadata
    };

    // Call Flows endpoint
    var result = callFlowsEndpoint(payload);

    if (result.success) {
      logInfo('Request submitted to Flows successfully');
      updateRequestItem(current, true, 'Success');
    } else {
      var errorMsg = result.error || 'HTTP ' + result.statusCode + ': ' + result.body;
      logError('Failed to submit request to Flows: ' + errorMsg);
      updateRequestItem(current, false, errorMsg);
    }

  } catch (e) {
    logError('Unexpected error in business rule: ' + e.message);
    updateRequestItem(current, false, 'Unexpected error: ' + e.message);
  }

})(current, previous);
`;
}
