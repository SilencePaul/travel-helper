import "@testing-library/jest-dom/vitest";
import {
  IDBCursor,
  IDBCursorWithValue,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRecord,
  IDBRequest,
  IDBTransaction,
  IDBVersionChangeEvent,
  indexedDB,
} from "fake-indexeddb";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

const indexedDbGlobals = {
  indexedDB,
  IDBCursor,
  IDBCursorWithValue,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRecord,
  IDBRequest,
  IDBTransaction,
  IDBVersionChangeEvent,
};
Object.defineProperties(globalThis, Object.fromEntries(Object.entries(indexedDbGlobals).map(([key, value]) => [key, {
  configurable: true,
  enumerable: false,
  value,
  writable: true,
}])));

afterEach(cleanup);
