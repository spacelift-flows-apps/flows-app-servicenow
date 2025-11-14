# ServiceNow

## Description

App for integrating with ServiceNow Service Catalog. Create catalog items that trigger flows when users request them, and update request statuses from your flows.

Uses OAuth2 client credentials for authentication.

## Configuration

The app requires ServiceNow connection details:

- `instanceUrl` - Your ServiceNow instance URL (e.g., https://dev12345.service-now.com) - no trailing slash (required)
- `clientId` - OAuth2 Client ID from ServiceNow integration (required)
- `clientSecret` - OAuth2 Client Secret from ServiceNow integration (required)

See installation instructions for OAuth2 setup steps and required user roles.

## Blocks

- `catalogItem`
  - Description: Creates a ServiceNow catalog item with custom variables. When users request the item in ServiceNow, triggers a flow with the request details. Automatically sets up business rules and REST messages in ServiceNow.

- `updateRequest`
  - Description: Updates a ServiceNow request item status and adds comments or work notes. Use this to mark requests as completed, failed, or in progress from your flows.
