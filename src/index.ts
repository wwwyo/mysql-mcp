#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import mysql from "mysql2/promise";

const server = new Server(
  {
    name: "example-servers/mysql",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

// 環境変数からデータベースURLを取得
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("環境変数DATABASE_URLが設定されていません");
  process.exit(1);
}

// リソースのベースURLを設定
const resourceBaseUrl = new URL(databaseUrl);
resourceBaseUrl.protocol = "mysql:";
resourceBaseUrl.password = "";

// データベース接続プールの作成
const pool = mysql.createPool(databaseUrl);

const SCHEMA_PATH = "schema";

// リソース一覧の取得ハンドラ
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = ?",
      [resourceBaseUrl.pathname.replace("/", "")]
    );

    return {
      resources: (rows as any[]).map((row) => ({
        uri: new URL(`${row.TABLE_NAME}/${SCHEMA_PATH}`, resourceBaseUrl).href,
        mimeType: "application/json",
        name: `"${row.TABLE_NAME}" database schema`,
      })),
    };
  } finally {
    connection.release();
  }
});

// リソース読み取りハンドラ
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const resourceUrl = new URL(request.params.uri);

  const pathComponents = resourceUrl.pathname.split("/");
  const schema = pathComponents.pop();
  const tableName = pathComponents.pop();

  if (schema !== SCHEMA_PATH) {
    throw new Error("Invalid resource URI");
  }

  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.query(
      "SELECT column_name, data_type, is_nullable, column_key " +
        "FROM information_schema.columns WHERE table_name = ? AND table_schema = ?",
      [tableName, resourceBaseUrl.pathname.replace("/", "")]
    );

    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "application/json",
          text: JSON.stringify(rows, null, 2),
        },
      ],
    };
  } finally {
    connection.release();
  }
});

// ツール一覧の取得ハンドラ
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "query",
        description: "Run a read-only SQL query",
        inputSchema: {
          type: "object",
          properties: {
            sql: { type: "string" },
          },
        },
      },
    ],
  };
});

// ツール実行ハンドラ
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "query") {
    const sql = request.params.arguments?.sql as string;

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      connection.query("SET TRANSACTION READ ONLY");

      const [rows] = await connection.query(sql);
      await connection.commit();

      return {
        content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
        isError: false,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
  throw new Error(`Unknown tool: ${request.params.name}`);
});

// サーバーの起動
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch(console.error);
