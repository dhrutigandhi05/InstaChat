import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters, APIGatewayProxyResult } from "aws-lambda";
import AWS, { AWSError } from "aws-sdk";
import { connect } from "http2";

type Action = "$connect" | "$disconnect" | "getMessage" | "sendMessage" | "getClients";

const clientTableName = "Clients";
const response = {
  statusCode: 200,
  body: "",
}
const docClient = new AWS.DynamoDB.DocumentClient();
const apiGateway = new AWS.ApiGatewayManagementApi({
  endpoint: process.env["WSSAPIGATEWAYENDPOINT"],
});

export const handle = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const connectionId = event.requestContext.connectionId as string
  const routeKey = event.requestContext.routeKey as Action;

  switch (routeKey) {
    case "$connect":
      return handleConnection(connectionId, event.queryStringParameters);
    case "$disconnect":
      return handleDisconnection(connectionId);
    case "getMessage":
      //return handleGetMessage(connectionId);
    case "sendMessage":
    case "getClients":
      return handleGetClients(connectionId);

    default:
      return {
        statusCode: 500,
        body: "",
      };
  }
};

const handleConnection = async(
  connectionId: string, 
  queryParams: APIGatewayProxyEventQueryStringParameters | null,
): Promise<APIGatewayProxyResult> => {
  if (!queryParams || !queryParams["nickname"]) {
    return {
        statusCode: 403,
        body: "",
    };
  }

  // creates new user
  await docClient.put({
    TableName: clientTableName,
    Item: {
      connectionId, 
      nickname: queryParams["nickname"],
    },
  })
  .promise();

  

  return response;
};

const handleDisconnection = async(connectionId: string): Promise<APIGatewayProxyResult> => {
  await docClient.delete({
    TableName: clientTableName,
    Key: {
      connectionId,
    },
  })
  .promise();

  return response;
};

const notifyAllClients = async (connectionIdToExclude: string) => {
  
}

const handleGetClients = async (connectionId: string): Promise<APIGatewayProxyResult> => {
  const output = await docClient.scan({
    TableName: clientTableName,
  })
  .promise();

  const clients = output.Items || [];

  try {
    await apiGateway.postToConnection({
      ConnectionId: connectionId,
      Data: JSON.stringify(clients),
    })
    .promise();
  } catch (e) {
    if ((e as AWSError).statusCode !== 410) {
      throw e
    }

    await docClient.delete({
      TableName: clientTableName,
      Key: {
        connectionId,
      },
    })
    .promise();
  }

  return response;
};