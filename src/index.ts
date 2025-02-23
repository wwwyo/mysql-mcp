#!/usr/bin/env node

import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import mysql from "mysql2/promise";
import { z } from "zod";

const server = new McpServer(
  {
    name: "mysql",
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

// テーブルスキーマのリソース登録
server.resource(
  "table-schema",
  new ResourceTemplate("mysql://{tableName}/schema", {
    list: async () => {
      const connection = await pool.getConnection();
      try {
        const [rows] = await connection.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = ?",
          [resourceBaseUrl.pathname.replace("/", "")]
        );
        return {
          resources: (rows as any[]).map((row) => ({
            uri: new URL(`${row.TABLE_NAME}/schema`, resourceBaseUrl).href,
            mimeType: "application/json",
            name: `"${row.TABLE_NAME}" database schema`,
          })),
        };
      } finally {
        connection.release();
      }
    },
  }),
  async (uri, { tableName }) => {
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
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(rows, null, 2),
          },
        ],
      };
    } finally {
      connection.release();
    }
  }
);

// クエリ実行ツールの登録
server.tool(
  "query",
  "Run a read-only SQL query",
  {
    sql: z.string(),
  },
  async (params) => {
    const sql = params.sql;
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.query(sql);
      return {
        content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
        isError: false,
      };
    } finally {
      connection.release();
    }
  }
);

// サーバーの起動
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch(console.error);
