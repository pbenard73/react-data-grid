import { useCallback, useMemo } from "react";
import type { Key } from "react";

import { useLatestFunc } from "./hooks";
import { assertIsValidKeyGetter, getLeftRightKey } from "./utils";
import type {
  CellClipboardEvent,
  CellCopyArgs,
  CellKeyboardEvent,
  CellKeyDownArgs,
  CellPasteArgs,
  Column,
  GroupRow,
  Maybe,
  Omit,
  RenderRowProps,
  RowHeightArgs,
  RowsChangeData,
} from "./types";
import { renderToggleGroup } from "./cellRenderers";
import { SELECT_COLUMN_KEY } from "./Columns";
import { DataGrid } from "./DataGrid";
import type { DataGridProps } from "./DataGrid";
import { useDefaultRenderers } from "./DataGridDefaultRenderersContext";
import GroupedRow from "./GroupRow";
import { defaultRenderRow } from "./Row";

export interface TreeDataGridProps<
  R,
  SR = unknown,
  K extends Key = Key,
> extends Omit<
  DataGridProps<R, SR, K>,
  | "columns"
  | "role"
  | "aria-rowcount"
  | "rowHeight"
  | "onFill"
  | "isRowSelectionDisabled"
> {
  columns: readonly Column<NoInfer<R>, NoInfer<SR>>[];
  rowHeight?: Maybe<number | ((args: RowHeightArgs<NoInfer<R>>) => number)>;
  groupBy: readonly string[];
  rowGrouper: (
    rows: readonly NoInfer<R>[],
    columnKey: string,
  ) => Record<string, readonly NoInfer<R>[]>;
  expandedGroupIds: ReadonlySet<unknown>;
  onExpandedGroupIdsChange: (expandedGroupIds: Set<unknown>) => void;
  groupIdGetter?: Maybe<(groupKey: string, parentId?: string) => string>;
}

type GroupByDictionary<TRow> = Record<
  string,
  {
    readonly childRows: readonly TRow[];
    readonly childGroups: readonly TRow[] | Readonly<GroupByDictionary<TRow>>;
    readonly startRowIndex: number;
  }
>;

export function TreeDataGrid<R, SR = unknown, K extends Key = Key>({
  columns: rawColumns,
  rows: rawRows,
  rowHeight: rawRowHeight,
  rowKeyGetter: rawRowKeyGetter,
  onCellKeyDown: rawOnCellKeyDown,
  onCellCopy: rawOnCellCopy,
  onCellPaste: rawOnCellPaste,
  onRowsChange,
  selectedRows: rawSelectedRows,
  onSelectedRowsChange: rawOnSelectedRowsChange,
  renderers,
  groupBy: rawGroupBy,
  rowGrouper,
  expandedGroupIds,
  onExpandedGroupIdsChange,
  groupIdGetter: rawGroupIdGetter,
  ...props
}: TreeDataGridProps<R, SR, K>) {
  const defaultRenderers = useDefaultRenderers<R, SR>();
  const rawRenderRow =
    renderers?.renderRow ?? defaultRenderers?.renderRow ?? defaultRenderRow;
  const headerAndTopSummaryRowsCount = 1 + (props.topSummaryRows?.length ?? 0);
  const { leftKey, rightKey } = getLeftRightKey(props.direction);
  const toggleGroupLatest = useLatestFunc(toggleGroup);
  const groupIdGetter = rawGroupIdGetter ?? defaultGroupIdGetter;

  const { columns, groupBy } = useMemo(() => {
    const columns = rawColumns.toSorted(({ key: aKey }, { key: bKey }) => {
      if (aKey === SELECT_COLUMN_KEY) return -1;
      if (bKey === SELECT_COLUMN_KEY) return 1;
      if (rawGroupBy.includes(aKey)) {
        if (rawGroupBy.includes(bKey)) {
          return rawGroupBy.indexOf(aKey) - rawGroupBy.indexOf(bKey);
        }
        return -1;
      }
      if (rawGroupBy.includes(bKey)) return 1;
      return 0;
    });

    const groupBy: string[] = [];
    for (const [index, column] of columns.entries()) {
      if (rawGroupBy.includes(column.key)) {
        groupBy.push(column.key);
        columns[index] = {
          ...column,
          frozen: true,
          renderCell: (cellProps) => {
            // On GroupRow, the cell is handled by renderGroupCell — hide it here.
            // On detail rows, use the column's original renderCell (or fall back to nothing).
            if ("groupKey" in (cellProps.row as object)) return null;
            return column.renderCell ? column.renderCell(cellProps) : null;
          },
          renderGroupCell: column.renderGroupCell ?? renderToggleGroup,
          editable: false,
        };
      }
    }

    return { columns, groupBy };
  }, [rawColumns, rawGroupBy]);

  const [groupedRows, rowsCount] = useMemo(() => {
    if (groupBy.length === 0) return [undefined, rawRows.length];

    const groupRows = (
      rows: readonly R[],
      [groupByKey, ...remainingGroupByKeys]: readonly string[],
      startRowIndex: number,
    ): [Readonly<GroupByDictionary<R>>, number] => {
      let groupRowsCount = 0;
      const groups: GroupByDictionary<R> = {};
      for (const [key, childRows] of Object.entries(
        rowGrouper(rows, groupByKey),
      )) {
        const [childGroups, childRowsCount] =
          remainingGroupByKeys.length === 0
            ? [childRows, childRows.length]
            : groupRows(
                childRows,
                remainingGroupByKeys,
                startRowIndex + groupRowsCount + 1,
              );
        groups[key] = {
          childRows,
          childGroups,
          startRowIndex: startRowIndex + groupRowsCount,
        };
        groupRowsCount += childRowsCount + 1;
      }
      return [groups, groupRowsCount];
    };

    return groupRows(rawRows, groupBy, 0);
  }, [groupBy, rowGrouper, rawRows]);

  // --- OPTIMISATION 1 ---
  // On construit en une seule passe :
  //   - flattenedRows  : le tableau de lignes affiché
  //   - allGroupRows   : Set pour isGroupRow en O(1)
  //   - rowIndexMap    : Map<row, index> pour remplacer tous les indexOf O(n)
  //   - parentMap      : Map<row, [GroupRow, rowIdx]> pour getParentRowAndIndex en O(1)
  //   - rawRowIndexMap : Map<R, index> dans rawRows pour handleRowsChange en O(1)
  const [rows, isGroupRow, rowIndexMap, parentMap, rawRowIndexMap] =
    useMemo((): [
      readonly (R | GroupRow<R>)[],
      (row: R | GroupRow<R>) => row is GroupRow<R>,
      Map<R | GroupRow<R>, number>,
      Map<R | GroupRow<R>, readonly [GroupRow<R>, number]>,
      Map<R, number>,
    ] => {
      // Index rawRows once — O(n)
      const rawRowIndexMap = new Map<R, number>();
      for (let i = 0; i < rawRows.length; i++) {
        rawRowIndexMap.set(rawRows[i], i);
      }

      const allGroupRows = new Set<unknown>();

      if (!groupedRows) {
        const rowIndexMap = new Map<R | GroupRow<R>, number>();
        for (let i = 0; i < rawRows.length; i++) rowIndexMap.set(rawRows[i], i);
        return [rawRows, isGroupRow, rowIndexMap, new Map(), rawRowIndexMap];
      }

      const flattenedRows: (R | GroupRow<R>)[] = [];
      const rowIndexMap = new Map<R | GroupRow<R>, number>();
      const parentMap = new Map<
        R | GroupRow<R>,
        readonly [GroupRow<R>, number]
      >();

      const expandGroup = (
        rows: GroupByDictionary<R> | readonly R[],
        parentId: string | undefined,
        level: number,
        parentGroupRow: GroupRow<R> | undefined,
      ): void => {
        if (isReadonlyArray(rows)) {
          for (const row of rows) {
            const idx = flattenedRows.length;
            rowIndexMap.set(row, idx);
            flattenedRows.push(row);
            if (parentGroupRow !== undefined) {
              parentMap.set(row, [
                parentGroupRow,
                rowIndexMap.get(parentGroupRow)!,
              ] as const);
            }
          }
          return;
        }
        Object.keys(rows).forEach((groupKey, posInSet, keys) => {
          const id = groupIdGetter(groupKey, parentId);
          const isExpanded = expandedGroupIds.has(id);
          const { childRows, childGroups, startRowIndex } = rows[groupKey];

          const groupRow: GroupRow<R> = {
            id,
            parentId,
            groupKey,
            isExpanded,
            childRows,
            level,
            posInSet,
            startRowIndex,
            setSize: keys.length,
          };

          const idx = flattenedRows.length;
          flattenedRows.push(groupRow);
          allGroupRows.add(groupRow);
          rowIndexMap.set(groupRow, idx);

          if (parentGroupRow !== undefined) {
            parentMap.set(groupRow, [
              parentGroupRow,
              rowIndexMap.get(parentGroupRow)!,
            ] as const);
          }

          if (isExpanded) {
            expandGroup(childGroups, id, level + 1, groupRow);
          }
        });
      };

      expandGroup(groupedRows, undefined, 0, undefined);
      return [
        flattenedRows,
        isGroupRow,
        rowIndexMap,
        parentMap,
        rawRowIndexMap,
      ];

      function isGroupRow(row: R | GroupRow<R>): row is GroupRow<R> {
        return allGroupRows.has(row);
      }
    }, [expandedGroupIds, groupedRows, rawRows, groupIdGetter]);

  const rowHeight = useMemo(() => {
    if (typeof rawRowHeight === "function") {
      return (row: R | GroupRow<R>): number => {
        if (isGroupRow(row)) {
          return rawRowHeight({ type: "GROUP", row });
        }
        return rawRowHeight({ type: "ROW", row });
      };
    }
    return rawRowHeight;
  }, [isGroupRow, rawRowHeight]);

  // --- OPTIMISATION 2 ---
  // getParentRowAndIndex : O(1) via la Map au lieu de O(n) avec indexOf + boucle
  const getParentRowAndIndex = useCallback(
    (row: R | GroupRow<R>) => {
      return parentMap.get(row) as readonly [GroupRow<R>, number] | undefined;
    },
    [parentMap],
  );

  // --- OPTIMISATION 3 ---
  // rowKeyGetter : O(1) via rowIndexMap au lieu de O(n) indexOf
  const rowKeyGetter = useCallback(
    (row: R | GroupRow<R>) => {
      if (isGroupRow(row)) {
        return row.id;
      }

      if (typeof rawRowKeyGetter === "function") {
        return rawRowKeyGetter(row);
      }

      const parentRowAndIndex = getParentRowAndIndex(row);
      if (parentRowAndIndex !== undefined) {
        const { startRowIndex, childRows } = parentRowAndIndex[0];
        // O(1) : on connaît l'index global, on en déduit la position dans childRows
        const globalIdx = rowIndexMap.get(row)!;
        const parentIdx = parentRowAndIndex[1];
        const groupIndex = globalIdx - parentIdx - 1;
        return startRowIndex + groupIndex + 1;
      }

      return rowIndexMap.get(row) ?? -1;
    },
    [getParentRowAndIndex, isGroupRow, rawRowKeyGetter, rowIndexMap],
  );

  const selectedRows = useMemo((): Maybe<ReadonlySet<Key>> => {
    if (rawSelectedRows == null) return null;

    assertIsValidKeyGetter<R, K>(rawRowKeyGetter);

    const selectedRows = new Set<Key>(rawSelectedRows);
    for (const row of rows) {
      if (isGroupRow(row)) {
        const isGroupRowSelected = row.childRows.every((cr) =>
          rawSelectedRows.has(rawRowKeyGetter(cr)),
        );
        if (isGroupRowSelected) {
          selectedRows.add(row.id);
        }
      }
    }

    return selectedRows;
  }, [isGroupRow, rawRowKeyGetter, rawSelectedRows, rows]);

  function onSelectedRowsChange(newSelectedRows: Set<Key>) {
    if (!rawOnSelectedRowsChange) return;

    assertIsValidKeyGetter<R, K>(rawRowKeyGetter);

    const newRawSelectedRows = new Set(rawSelectedRows);
    for (const row of rows) {
      const key = rowKeyGetter(row);
      if (selectedRows?.has(key) && !newSelectedRows.has(key)) {
        if (isGroupRow(row)) {
          for (const cr of row.childRows) {
            newRawSelectedRows.delete(rawRowKeyGetter(cr));
          }
        } else {
          newRawSelectedRows.delete(key as K);
        }
      } else if (!selectedRows?.has(key) && newSelectedRows.has(key)) {
        if (isGroupRow(row)) {
          for (const cr of row.childRows) {
            newRawSelectedRows.add(rawRowKeyGetter(cr));
          }
        } else {
          newRawSelectedRows.add(key as K);
        }
      }
    }

    rawOnSelectedRowsChange(newRawSelectedRows);
  }

  function handleKeyDown(
    args: CellKeyDownArgs<R, SR>,
    event: CellKeyboardEvent,
  ) {
    rawOnCellKeyDown?.(args, event);
    if (event.isGridDefaultPrevented()) return;

    if (args.mode === "EDIT") return;
    const { column, rowIdx, setActivePosition } = args;
    const idx = column?.idx ?? -1;
    const row = rows[rowIdx];

    if (!isGroupRow(row)) return;
    if (
      idx === -1 &&
      ((event.key === leftKey && row.isExpanded) ||
        (event.key === rightKey && !row.isExpanded))
    ) {
      event.preventDefault();
      event.preventGridDefault();
      toggleGroup(row.id);
    }

    if (
      idx === -1 &&
      event.key === leftKey &&
      !row.isExpanded &&
      row.level !== 0
    ) {
      const parentRowAndIndex = getParentRowAndIndex(row);
      if (parentRowAndIndex !== undefined) {
        event.preventGridDefault();
        setActivePosition({ idx, rowIdx: parentRowAndIndex[1] });
      }
    }
  }

  function handleCellCopy(
    { row, column }: CellCopyArgs<NoInfer<R>, NoInfer<SR>>,
    event: CellClipboardEvent,
  ) {
    if (!isGroupRow(row)) {
      rawOnCellCopy?.({ row, column }, event);
    }
  }

  function handleCellPaste(
    { row, column }: CellPasteArgs<NoInfer<R>, NoInfer<SR>>,
    event: CellClipboardEvent,
  ) {
    return isGroupRow(row) ? row : rawOnCellPaste!({ row, column }, event);
  }

  // --- OPTIMISATION 4 ---
  // handleRowsChange : O(1) via rawRowIndexMap au lieu de O(n) indexOf
  function handleRowsChange(
    updatedRows: R[],
    { indexes, column }: RowsChangeData<R, SR>,
  ) {
    if (!onRowsChange) return;
    const updatedRawRows = [...rawRows];
    const rawIndexes: number[] = [];
    for (const index of indexes) {
      const row = rows[index] as R;
      const rawIndex = rawRowIndexMap.get(row) ?? -1;
      if (rawIndex !== -1) {
        updatedRawRows[rawIndex] = updatedRows[index];
        rawIndexes.push(rawIndex);
      }
    }
    onRowsChange(updatedRawRows, { indexes: rawIndexes, column });
  }

  function toggleGroup(groupId: unknown) {
    const newExpandedGroupIds = new Set(expandedGroupIds);
    if (newExpandedGroupIds.has(groupId)) {
      newExpandedGroupIds.delete(groupId);
    } else {
      newExpandedGroupIds.add(groupId);
    }
    onExpandedGroupIdsChange(newExpandedGroupIds);
  }

  function renderRow(
    key: Key,
    {
      row,
      rowClass,
      onCellMouseDown,
      onCellClick,
      onCellDoubleClick,
      onCellContextMenu,
      onRowChange,
      draggedOverCellIdx,
      activeCellEditor,
      isRowSelectionDisabled,
      isTreeGrid,
      ...rowProps
    }: RenderRowProps<R, SR>,
  ) {
    if (isGroupRow(row)) {
      const { startRowIndex } = row;
      return (
        <GroupedRow
          key={key}
          {...rowProps}
          aria-rowindex={headerAndTopSummaryRowsCount + startRowIndex + 1}
          row={row}
          groupBy={groupBy}
          toggleGroup={toggleGroupLatest}
        />
      );
    }

    // --- OPTIMISATION 5 ---
    // ariaRowIndex : O(1) via parentMap + rowIndexMap au lieu de childRows.indexOf O(n)
    let ariaRowIndex = rowProps["aria-rowindex"];
    const parentRowAndIndex = getParentRowAndIndex(row);
    if (parentRowAndIndex !== undefined) {
      const { startRowIndex } = parentRowAndIndex[0];
      const globalIdx = rowIndexMap.get(row)!;
      const parentIdx = parentRowAndIndex[1];
      const groupIndex = globalIdx - parentIdx - 1;
      ariaRowIndex =
        startRowIndex + headerAndTopSummaryRowsCount + groupIndex + 2;
    }

    return rawRenderRow(key, {
      ...rowProps,
      "aria-rowindex": ariaRowIndex,
      row,
      rowClass,
      onCellMouseDown,
      onCellClick,
      onCellDoubleClick,
      onCellContextMenu,
      onRowChange,
      draggedOverCellIdx,
      activeCellEditor,
      isRowSelectionDisabled,
      isTreeGrid,
    });
  }

  return (
    <DataGrid<R, SR>
      {...props}
      role="treegrid"
      aria-rowcount={
        rowsCount +
        1 +
        (props.topSummaryRows?.length ?? 0) +
        (props.bottomSummaryRows?.length ?? 0)
      }
      columns={columns}
      rows={rows as R[]}
      rowHeight={rowHeight}
      rowKeyGetter={rowKeyGetter}
      onRowsChange={handleRowsChange}
      selectedRows={selectedRows}
      onSelectedRowsChange={onSelectedRowsChange}
      onCellKeyDown={handleKeyDown}
      onCellCopy={handleCellCopy}
      onCellPaste={rawOnCellPaste ? handleCellPaste : undefined}
      renderers={{
        ...renderers,
        renderRow,
      }}
    />
  );
}

function defaultGroupIdGetter(groupKey: string, parentId: string | undefined) {
  return parentId !== undefined ? `${parentId}__${groupKey}` : groupKey;
}

function isReadonlyArray(arr: unknown): arr is readonly unknown[] {
  return Array.isArray(arr);
}
