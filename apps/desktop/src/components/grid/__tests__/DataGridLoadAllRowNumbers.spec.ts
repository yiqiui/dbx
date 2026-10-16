// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, shallowRef, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { QueryResult } from "@/types/database";
import { TooltipProvider } from "@/components/ui/tooltip";

const backendMocks = vi.hoisted(() => ({
  buildTableSelectSql: vi.fn(async ({ tableName, orderBy }: { tableName: string; orderBy?: string }) => `SELECT * FROM ${tableName}${orderBy ? ` ORDER BY ${orderBy}` : ""}`),
  loadEditorSettings: vi.fn().mockResolvedValue({}),
  saveEditorSettings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return {
    ...actual,
    buildTableSelectSql: backendMocks.buildTableSelectSql,
    loadEditorSettings: backendMocks.loadEditorSettings,
    saveEditorSettings: backendMocks.saveEditorSettings,
  };
});

vi.mock("vue-virtual-scroller", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    RecycleScroller: defineComponent({
      props: {
        items: {
          type: Array as PropType<unknown[]>,
          default: () => [],
        },
      },
      setup(props, { attrs, slots }) {
        return () =>
          h(
            "div",
            attrs,
            props.items.map((item) => slots.default?.({ item })),
          );
      },
    }),
  };
});

vi.mock("@/composables/useDataGridColumnResize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/composables/useDataGridColumnResize")>();
  const { ref } = await import("vue");
  return {
    ...actual,
    useDataGridColumnResize: () => ({
      initColumnWidths: vi.fn(),
      onResizeStart: vi.fn(),
      autoFitColumn: vi.fn(),
      renderedColumnWidths: ref([120]),
      totalWidth: ref(120),
      columnVars: ref({ "--total-w": "120px" }),
      getIsResizing: () => false,
    }),
  };
});

import DataGrid from "../DataGrid.vue";
import { useSettingsStore } from "@/stores/settingsStore";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

interface MountOptions {
  /** Rows currently loaded, already shifted by the page the user is on. */
  rows?: unknown[][];
  pageOffset?: number;
  pageLimit?: number;
  hasMore?: boolean;
  /**
   * When set, the grid answers `paginate` from a fake server holding this many
   * rows so the append path can be exercised end to end. When omitted the grid
   * stays on the rows it was handed (a load-all click only flips the labels).
   */
  totalRows?: number;
}

interface PaginateCall {
  offset: number;
  limit: number;
  append: boolean;
}

function mountGrid(options: MountOptions = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({ dataGridRenderMode: "canvas" });

  const pageSize = options.pageLimit ?? 2;
  const pageOffsetRef = shallowRef(options.pageOffset ?? 0);
  const resultRef = shallowRef(
    markRaw<QueryResult>({
      columns: ["id", "name"],
      rows: options.rows ?? [
        [3, "C"],
        [4, "D"],
      ],
      affected_rows: 0,
      execution_time_ms: 0,
      has_more: options.hasMore ?? false,
    }),
  );
  const serverRows = Array.from({ length: options.totalRows ?? 0 }, (_, index) => [index + 1, `R${index + 1}`]);
  const paginateCalls: PaginateCall[] = [];

  function answerPaginate(offset: number, limit: number, appendRequested: boolean) {
    paginateCalls.push({ offset, limit, append: appendRequested });
    if (serverRows.length === 0) return;
    const append = appendRequested && offset > 0 && resultRef.value.rows.length === offset;
    const rows = append ? [...resultRef.value.rows, ...serverRows.slice(offset, offset + limit)] : serverRows.slice(offset, offset + limit);
    resultRef.value = markRaw<QueryResult>({
      columns: ["id", "name"],
      rows,
      affected_rows: 0,
      execution_time_ms: 0,
      has_more: serverRows.length > offset + rows.length,
      appended_from_row_count: append ? offset : undefined,
    });
    pageOffsetRef.value = offset;
  }

  const host = document.createElement("div");
  document.body.append(host);
  const Root = defineComponent({
    setup() {
      return () =>
        h(
          TooltipProvider,
          { delayDuration: 0 },
          {
            default: () =>
              h(DataGrid, {
                result: resultRef.value,
                databaseType: "mysql",
                context: "table-data",
                connectionId: "conn-1",
                database: "db1",
                paginationEnabled: true,
                loadAllRowsEnabled: true,
                pageOffset: pageOffsetRef.value,
                pageLimit: pageSize,
                totalRowCount: options.totalRows,
                tableMeta: {
                  tableName: "items",
                  columns: [
                    { name: "id", data_type: "int" },
                    { name: "name", data_type: "varchar" },
                  ],
                  primaryKeys: ["id"],
                },
                onPaginate: (offset: number, limit: number, _where?: string, _orderBy?: string, appendRequested?: boolean) => answerPaginate(offset, limit, appendRequested === true),
                onExecuteSql: vi.fn().mockResolvedValue(undefined),
              }),
          },
        );
    },
  });
  const app = createApp(Root);
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  // Row numbers live in the DOM surface; canvas mode paints them instead.
  settingsStore.updateEditorSettings({ dataGridRenderMode: "dom" });
  mountedApps.push({ app, host });
  return { host, resultRef, pageOffsetRef, paginateCalls };
}

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function rowNumberLabels(host: HTMLElement): string[] {
  return [...host.querySelectorAll<HTMLElement>(".data-grid-row-number")].map((node) => node.textContent?.trim() ?? "");
}

function loadAllButton(host: HTMLElement): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="Load all and go to the last row"]');
  if (!button) throw new Error("Load-all button not found");
  return button;
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("DataGrid row numbers after loading all rows", () => {
  it("numbers the loaded rows from the start of the result instead of the page the user came from", async () => {
    // The user is on page 2: the two loaded rows are result rows 3 and 4.
    const { host } = mountGrid({ pageOffset: 2, pageLimit: 2 });
    await settle();

    expect(rowNumberLabels(host)).toEqual(["3", "4"]);

    loadAllButton(host).click();
    await settle();

    // Once every row is loaded the grid shows the whole result, so numbering
    // restarts at 1 instead of keeping the page-2 offset.
    expect(rowNumberLabels(host)).toEqual(["1", "2"]);
  });

  it("reloads from the first row before appending the rest when load-all starts on a later page", async () => {
    // 6 rows, 2 per page; the user is on page 2 (rows 3 and 4).
    const { host, paginateCalls } = mountGrid({ pageOffset: 2, pageLimit: 2, totalRows: 6 });
    await settle();
    expect(rowNumberLabels(host)).toEqual(["3", "4"]);

    loadAllButton(host).click();
    await settle();

    // The run must not append onto page 2 (that would never fetch rows 1-2):
    // it replaces the result from server offset 0 first...
    expect(paginateCalls[0]).toEqual({ offset: 0, limit: 2, append: false });
    // ...then appends the remaining rows from the end of page 1.
    expect(paginateCalls[1]).toEqual({ offset: 2, limit: 4, append: true });
    expect(paginateCalls).toHaveLength(2);

    // The grid now holds rows 1..6 with no duplicates, numbered from 1.
    expect(rowNumberLabels(host)).toEqual(["1", "2", "3", "4", "5", "6"]);
  });
});
