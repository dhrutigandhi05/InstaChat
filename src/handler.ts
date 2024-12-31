import { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters, APIGatewayProxyResult } from "aws-lambda";
import AWS, { AWSError } from "aws-sdk";
import { Key } from "aws-sdk/clients/dynamodb";
import { v4 } from "uuid";

// websocket actions
type Action = "$connect" | "$disconnect" | "getMessage" | "sendMessage" | "getClients";
type Client = {
  connectionId: string;
  nickname: string;
};

type SMessageBody = {
  message: string;
  receiver: string;
};

type GMessageBody = {
  targetName: string;
  limit: number;
  startKey: Key | undefined;
}

const clientTableName = "Clients";
const messageTableName = "Messages";

class errors extends Error {}

const response = {
  statusCode: 200,
  body: "",
};

const error403 = {
  statusCode: 403,
  body: "",
};

const docClient = new AWS.DynamoDB.DocumentClient();
const apiGateway = new AWS.ApiGatewayManagementApi({
  endpoint: process.env["WSSAPIGATEWAYENDPOINT"],
});

// function handles websocket events
export const handle = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const connectionId = event.requestContext.connectionId as string
  const routeKey = event.requestContext.routeKey as Action;
  
  try {
    switch (routeKey) {
    case "$connect":
      return handleConnection(connectionId, event.queryStringParameters);
    case "$disconnect":
      return handleDisconnection(connectionId);
    case "sendMessage":
      return handleSendMessage(connectionId, parseSMessage(event.body));
    case "getMessage":
      return handleGetMessage(connectionId, parseGMessage(event.body));
    case "getClients":
      return handleGetClients(connectionId);
    default:
      return {
        statusCode: 500,
        body: "",
      };
    }
  } catch (e) {
    if (e instanceof errors) {
      await postToConnection(connectionId, e.message);
      return response;
    }

    throw e;
  }
};

// parse send message body
const parseSMessage = (body: string | null): SMessageBody => {
  const smessageBody = JSON.parse(body || "{}") as SMessageBody;

  // verify the structure of the message body
  if (!smessageBody || typeof smessageBody.message !== 'string' || typeof smessageBody.receiver !== 'string') {
    throw new errors('Invalid SM Body Type');
  }

  return smessageBody;
}

// parse get message body
const parseGMessage = (body: string | null): GMessageBody => {
  const gmessageBody = JSON.parse(body || "{}") as GMessageBody;

  // verify the structure of the message body
  if (!gmessageBody || typeof gmessageBody.targetName !== 'string' || typeof gmessageBody.limit !== 'number') {
    throw new errors('Invalid GM Body Type');
  }

  return gmessageBody;
};

// handles new websocket connection
const handleConnection = async(connectionId: string, queryParams: APIGatewayProxyEventQueryStringParameters | null,): Promise<APIGatewayProxyResult> => {
  // connection has to have a nickname
  if (!queryParams || !queryParams["nickname"]) {
    return error403;
  }
  
  const connectId = await getConnectionId(queryParams["nickname"]);
  if (connectId && await postToConnection(connectId, JSON.stringify({type: "ping"}))) {
    return error403;
  }
  
  // saves new user connection and nickname in the table
  await docClient.put({
      TableName: clientTableName,
      Item: {
        connectionId, 
        nickname: queryParams["nickname"],
      },
    }).promise();

  // notify all other clients that user has connected
  await notifyClients(connectionId);

  return response;
};

const getConnectionId = async (nickname: string): Promise<string | undefined> => {
  const out = await docClient.query({
    TableName: clientTableName,
    IndexName: "NicknameIndex",
    KeyConditionExpression: "#nickname = :nickname",
    ExpressionAttributeNames: {
      '#nickname': 'nickname'
    },
    ExpressionAttributeValues: {
      ":nickname": nickname,
    },
  }).promise();

  if (out.Count && out.Count > 0) {
    const client = (out.Items as Client[])[0];
    return client.connectionId;
  }

  return undefined;
}

// handles websocket disconnection
const handleDisconnection = async(connectionId: string): Promise<APIGatewayProxyResult> => {
  // deletes connection from the table
  await docClient.delete({
    TableName: clientTableName,
    Key: {
      connectionId,
    },
  }).promise();

  // notify all other clients that user has disconnected
  await notifyClients(connectionId);

  return response;
};

// notify all connected users if a new user has connected or disconnected
const notifyClients = async(connectionIdToExclude: string) => {
  const clients = await getClients();

  // filters clients from client[] that has the connectionIdToExclude
  await Promise.all(
    clients
      .filter((client) => client.connectionId !== connectionIdToExclude)
      .map(async (client) => {
        await postToConnection(client.connectionId, clientMessage(clients));
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
  }).promise();

  const clients = output.Items || [];
  return clients as Client[];
};

const postToConnection = async(connectionId: string, info: string): Promise<boolean> => {
  try {
    // get list of connected clients then send that list to websocket client
    await apiGateway.postToConnection({
      ConnectionId: connectionId,
      Data: info,
    }).promise();
    return true
  } catch (e) {
    // handle errors
    if ((e as AWSError).statusCode !== 410) {
      throw e;
    }

    // delete client from the table if its no long available
    await docClient.delete({
        TableName: clientTableName,
        Key: {
          connectionId,
        },
      })
      .promise();
    return false;
  }
};

const handleGetClients = async (connectionId: string): Promise<APIGatewayProxyResult> => {
  // get all clients
  const clients = await getClients();
  await postToConnection(connectionId, clientMessage(clients));
  return response;
};

const clientMessage = (clients: Client[]): string => JSON.stringify({type: "clients", value: {clients}});

// create message and save in message table
// send message to the person getting the message (receiver)
const handleSendMessage = async (senderId: string, body: SMessageBody): Promise<APIGatewayProxyResult> => {
  // get sender info
  const sender = await getClient(senderId);
  const nicknameToNickname = getNnToNn([sender.nickname, body.receiver]);
  
  // stores message in the message table
  await docClient.put({
    TableName: messageTableName,
    Item: {
      messageId: v4(), //v4 creates a random unique hash value
      createdAt: new Date().getTime(),
      nicknameToNickname: nicknameToNickname,
      message: body.message,
      sender: sender.nickname,
    }
  }).promise();

  const receiverConnectionId = await getConnectionId(body.receiver);
  
  // send message to reciever if connected
  if (receiverConnectionId) {
    await postToConnection(receiverConnectionId, JSON.stringify({
      type: 'message',
      value: {
        sender: sender.nickname,
        message: body.message,
      },
    }));
  }

  return response;
};

const getClient = async (connectionId: string) => {
  const output = await docClient.get({
    TableName: clientTableName,
    Key: {
      connectionId,
    },
  }).promise();

  return output.Item as Client;
};

const getNnToNn = (nicknames: string[]): string => nicknames.sort().join("#")

const handleGetMessage = async (connectionId: string, body: GMessageBody): Promise<APIGatewayProxyResult> => {
  const client = await getClient(connectionId);
  const nicknameToNickname = getNnToNn([client.nickname, body.targetName]);
  
  const output = await docClient.query({
    TableName: messageTableName,
    IndexName: "NicknameToNicknameIndex",
    KeyConditionExpression: "#nicknameToNickname = :nicknameToNickname",
    ExpressionAttributeNames: {
      '#nicknameToNickname': 'nicknameToNickname'
    },
    ExpressionAttributeValues: {
      ":nicknameToNickname": nicknameToNickname,
    },
    Limit: body.limit,
    ExclusiveStartKey: body.startKey,
    ScanIndexForward: false,
  }).promise();

  const messages = output.Items && output.Items.length > 0 ? output.Items : [];

  await postToConnection(connectionId, JSON.stringify({
    type: 'messages',
    value: {
      messages,
    },
  }));
  
  return response;
}