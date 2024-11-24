import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters, APIGatewayProxyResult } from "aws-lambda";
import AWS, { AWSError } from "aws-sdk";
import { connect } from "http2";

// websocket actions
type Action = "$connect" | "$disconnect" | "getMessage" | "sendMessage" | "getClients";
type Client = {
  connectionId: string
  nickname: string
}

const clientTableName = "Clients";
const response = {
  statusCode: 200,
  body: "",
}
const docClient = new AWS.DynamoDB.DocumentClient();
const apiGateway = new AWS.ApiGatewayManagementApi({
  endpoint: process.env["WSSAPIGATEWAYENDPOINT"],
});

// function handles websocket events
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

// handles new websocket connection
const handleConnection = async(
  connectionId: string, 
  queryParams: APIGatewayProxyEventQueryStringParameters | null,
  ): Promise<APIGatewayProxyResult> => {
  // connection has to have a nickname
  if (!queryParams || !queryParams["nickname"]) {
    return {
        statusCode: 403,
        body: "",
    };
  }

  // saves new user connection and nickname in the table
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

// handles websocket disconnection
const handleDisconnection = async(connectionId: string): Promise<APIGatewayProxyResult> => {
  // deletes connection from the table
  await docClient.delete({
    TableName: clientTableName,
    Key: {
      connectionId,
    },
  })
  .promise();

  return response;
};

const notifyClients = async(connectionIdToExclude: string) => {
  const clients = await getClients();

  // filters clients from client[] that has the connectionIdToExclude
  await Promise.all(
    clients
      .filter((client) => client.connectionId !== connectionIdToExclude)
      .map(async (client) => {
        await postToConnection(client.connectionId, JSON.stringify(clients));
      }),
  );

  // for (const client of clients) {
  //   if (client.connectionId === connectionIdToExclude){
  //     continue;
  //   }

  //   await postToConnection(client.connectionId, JSON.stringify(clients));
  // }
};

// gets all the clients from the table
const getClients = async(): Promise<Client[]> => {
  const output = await docClient.scan({
    TableName: clientTableName,
  })
  .promise();

  const clients = output.Items || [];
  return clients as Client[]
}

const postToConnection = async(connectionId: string, info: string) => {
  try {
    // get list of connected clients then send that list to websocket client
    await apiGateway.postToConnection({
      ConnectionId: connectionId,
      Data: info,
    })
    .promise();
  } catch (e) {
    // handle errors
    if ((e as AWSError).statusCode !== 410) {
      throw e
    }

    // delete client from the table if its no long available
    await docClient.delete({
      TableName: clientTableName,
      Key: {
        connectionId,
      },
    })
    .promise();
  }
}

const handleGetClients = async (connectionId: string): Promise<APIGatewayProxyResult> => {
  // get all clients
  const clients = await getClients();
  await postToConnection(connectionId, JSON.stringify(clients));
  return response;
};