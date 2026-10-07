"use client";

import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from "react";
import type { ForceGraphMethods, ForceGraphProps, NodeObject, LinkObject } from "react-force-graph-2d";
import { EDGE_COLOR, nodeColorFor, withAlpha } from "../lib/colors";
import type { GraphNode, MemoryGraph, StatusFilters, TypeFilters } from "../lib/types";
import Sidebar from "./Sidebar";

// react-force-graph-2d's own type is a generic function component (FCwithRef), whose type
// parameters get erased once wrapped by next/dynamic (dynamic() can't preserve a generic
// component's type parameters through the loader). Re-asserting the shape once here, at the
// import site, keeps every prop below properly typed against our real node/link shape instead
// of scattering "as never" casts through the JSX.
type FGNode = NodeObject<GraphNode>;
type FGLink = LinkObject<GraphNode>;
type FGMethods = ForceGraphMethods<FGNode, FGLink>;

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false }) as unknown as ForwardRefExoticComponent<
  ForceGraphProps<FGNode, FGLink> & RefAttributes<FGMethods>
>;

const POLL_INTERVAL_MS = 8000;

/**
 * The force simulation replaces each link's `source`/`target` id with the node object itself, in
 * place, once the graph has rendered — so any later pass over the same edges must accept both.
 */
function endpointId(endpoint: string | { id?: string | number }): string {
  return typeof endpoint === "object" && endpoint !== null ? String(endpoint.id) : endpoint;
}

const LAYOUT_KEYS = ["x", "y", "vx", "vy", "fx", "fy"] as const;

/** `next` with every node that also exists in `prev` placed where the simulation had put it. */
function withPositionsFrom(prev: MemoryGraph, next: MemoryGraph): MemoryGraph {
  const placed = new Map(prev.nodes.map((n) => [n.id, n as GraphNode & Partial<Record<(typeof LAYOUT_KEYS)[number], number>>]));
  for (const node of next.nodes as (GraphNode & Partial<Record<(typeof LAYOUT_KEYS)[number], number>>)[]) {
    const old = placed.get(node.id);
    if (!old) continue;
    for (const key of LAYOUT_KEYS) if (old[key] !== undefined) node[key] = old[key];
  }
  return next;
}

function nodeSize(node: GraphNode): number {
  return node.type === "memory" ? 6 : node.type === "file" ? 4.5 : 3.5;
}

export default function GraphView() {
  const searchParams = useSearchParams();
  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [search, setSearch] = useState("");
  // `whyanchor viewgraph --tag x` opens the page as /?tag=x: show only that tag's memories (and
  // the files/tags they connect to) until the user clears it.
  const [tagFilter, setTagFilter] = useState<string | null>(() => searchParams.get("tag"));
  const [typeFilters, setTypeFilters] = useState<TypeFilters>({ memory: true, file: true, tag: true });
  const [statusFilters, setStatusFilters] = useState<StatusFilters>({ active: true, stale: true, superseded: false });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const fgRef = useRef<FGMethods | null>(null);
  const hasFittedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  // ForceGraph2D's own auto-sizing falls back to window dimensions rather than its flex
  // container's actual size in this layout, overflowing past the sidebar — measuring the
  // container ourselves and passing explicit width/height sidesteps that entirely. Read the
  // size synchronously on mount (don't wait on ResizeObserver's first callback, which some
  // embedding contexts delay well past first paint) and keep observing for later resizes.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) setContainerSize({ width: rect.width, height: rect.height });

    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setContainerSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const lastPayloadRef = useRef<string | null>(null);

  const fetchGraph = useCallback(async () => {
    try {
      const res = await fetch("/api/graph", { cache: "no-store" });
      const payload = await res.text();
      const body = JSON.parse(payload);
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setError(null);
      setLastUpdated(new Date());
      // Every poll returns brand-new node objects without positions, which restarts the force
      // layout from scratch: the graph jumped every few seconds, clicks landed on empty space and
      // dragged nodes snapped back. Skip identical payloads, and keep existing nodes where they are.
      if (payload === lastPayloadRef.current) return;
      lastPayloadRef.current = payload;
      setGraph((prev) => (prev ? withPositionsFrom(prev, body as MemoryGraph) : (body as MemoryGraph)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGraph();
    const interval = setInterval(fetchGraph, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchGraph]);

  const nodeById = useMemo(() => {
    const map = new Map<string, GraphNode>();
    graph?.nodes.forEach((n) => map.set(n.id, n));
    return map;
  }, [graph]);

  const adjacency = useMemo(() => {
    const map = new Map<string, string[]>();
    const add = (a: string, b: string) => {
      if (!map.has(a)) map.set(a, []);
      map.get(a)!.push(b);
    };
    graph?.edges.forEach((e) => {
      add(endpointId(e.source), endpointId(e.target));
      add(endpointId(e.target), endpointId(e.source));
    });
    return map;
  }, [graph]);

  const nodeVisible = useCallback(
    (node: GraphNode) => {
      if (!typeFilters[node.type]) return false;
      if (node.type === "memory" && node.status && !statusFilters[node.status]) return false;
      return true;
    },
    [typeFilters, statusFilters]
  );

  const filteredGraphData = useMemo(() => {
    if (!graph) return { nodes: [] as GraphNode[], links: [] as MemoryGraph["edges"] };
    let visibleIds = new Set(graph.nodes.filter(nodeVisible).map((n) => n.id));
    if (tagFilter) {
      const memories = new Set(
        graph.nodes.filter((n) => n.type === "memory" && n.tags?.includes(tagFilter) && visibleIds.has(n.id)).map((n) => n.id)
      );
      const kept = new Set(memories);
      for (const e of graph.edges) {
        const [source, target] = [endpointId(e.source), endpointId(e.target)];
        if (memories.has(source) && visibleIds.has(target)) kept.add(target);
        if (memories.has(target) && visibleIds.has(source)) kept.add(source);
      }
      visibleIds = kept;
    }
    return {
      nodes: graph.nodes.filter((n) => visibleIds.has(n.id)),
      links: graph.edges.filter((e) => visibleIds.has(endpointId(e.source)) && visibleIds.has(endpointId(e.target))),
    };
  }, [graph, nodeVisible, tagFilter]);

  const clearTagFilter = useCallback(() => {
    setTagFilter(null);
    // Drop ?tag= so a reload doesn't bring the filter back.
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const matches = useCallback(
    (node: GraphNode) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      const haystack = [node.label, ...(node.tags ?? []), ...(node.refs ?? [])].join(" ").toLowerCase();
      return haystack.includes(q);
    },
    [search]
  );

  const stats = useMemo(() => {
    const counts = { memory: 0, file: 0, tag: 0 };
    graph?.nodes.forEach((n) => {
      counts[n.type] += 1;
    });
    return { ...counts, edges: graph?.edges.length ?? 0 };
  }, [graph]);

  const focusNode = useCallback(
    (id: string) => {
      setSelectedId(id);
      const node = nodeById.get(id) as (GraphNode & { x?: number; y?: number }) | undefined;
      if (node && fgRef.current && typeof node.x === "number" && typeof node.y === "number") {
        fgRef.current.centerAt(node.x, node.y, 500);
        fgRef.current.zoom(Math.max(fgRef.current.zoom(), 2.5), 500);
      }
    },
    [nodeById]
  );

  const nodeColor = useCallback(
    (node: FGNode) => {
      const color = nodeColorFor(node);
      return matches(node) ? color : withAlpha(color, 0.12);
    },
    [matches]
  );

  const linkColor = useCallback(
    (link: FGLink) => {
      const sourceId = typeof link.source === "object" ? link.source?.id : link.source;
      const targetId = typeof link.target === "object" ? link.target?.id : link.target;
      const source = sourceId !== undefined ? nodeById.get(String(sourceId)) : undefined;
      const target = targetId !== undefined ? nodeById.get(String(targetId)) : undefined;
      const base = EDGE_COLOR[link.type] ?? "#64748b";
      const dimmed = (source && !matches(source)) || (target && !matches(target));
      if (dimmed) return withAlpha(base, 0.06);
      return withAlpha(base, link.type === "tag" ? 0.45 : 0.85);
    },
    [matches, nodeById]
  );

  const nodeCanvasObject = useCallback(
    (node: FGNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const label = node.label.length > 24 ? `${node.label.slice(0, 23)}…` : node.label;
      const fontSize = 11 / globalScale;
      ctx.font = `${fontSize}px Inter, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = matches(node) ? "rgba(229, 231, 235, 0.85)" : "rgba(229, 231, 235, 0.12)";
      const r = nodeSize(node);
      ctx.fillText(label, (node.x ?? 0) + r + 3, node.y ?? 0);
    },
    [matches]
  );

  const handleEngineStop = useCallback(() => {
    if (!hasFittedRef.current) {
      fgRef.current?.zoomToFit(400, 48);
      hasFittedRef.current = true;
    }
  }, []);

  const selectedNode = selectedId ? nodeById.get(selectedId) ?? null : null;
  const connections = selectedId
    ? ((adjacency.get(selectedId) ?? []).map((id) => nodeById.get(id)).filter(Boolean) as GraphNode[])
    : [];

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar
        search={search}
        onSearchChange={setSearch}
        tagFilter={tagFilter}
        onClearTagFilter={clearTagFilter}
        typeFilters={typeFilters}
        onToggleType={(type) => setTypeFilters((f) => ({ ...f, [type]: !f[type] }))}
        statusFilters={statusFilters}
        onToggleStatus={(status) => setStatusFilters((f) => ({ ...f, [status]: !f[status] }))}
        stats={stats}
        selectedNode={selectedNode}
        connections={connections}
        onSelectNode={focusNode}
        lastUpdated={lastUpdated}
        onRefresh={fetchGraph}
        error={error}
      />
      <main ref={containerRef} className="relative min-w-0 flex-1 overflow-hidden bg-[#0b0f19]">
        {loading && !graph ? (
          <div className="flex h-full items-center justify-center text-sm text-gray-500">Loading graph…</div>
        ) : graph && graph.nodes.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-gray-500">
            No memory entries yet — run <code className="mx-1 text-gray-300">whyanchor capture</code> to add one.
          </div>
        ) : filteredGraphData.nodes.length === 0 ? (
          <div className="flex h-full items-center justify-center px-8 text-center text-sm text-gray-500">
            {tagFilter
              ? `No entries tagged “${tagFilter}” match the current filters — superseded entries are hidden by default.`
              : "Nothing matches the current filters."}
          </div>
        ) : containerSize.width > 0 && containerSize.height > 0 ? (
          <ForceGraph2D
            ref={fgRef}
            width={containerSize.width}
            height={containerSize.height}
            graphData={filteredGraphData}
            backgroundColor="#0b0f19"
            nodeColor={nodeColor}
            nodeVal={nodeSize}
            nodeLabel={(node) => node.label}
            nodeCanvasObjectMode={() => "after"}
            nodeCanvasObject={nodeCanvasObject}
            linkColor={linkColor}
            linkWidth={(link) => (link.type === "supersedes" ? 2 : 1)}
            linkDirectionalArrowLength={(link) => (link.type === "supersedes" ? 6 : 0)}
            linkDirectionalArrowRelPos={1}
            onNodeClick={(node) => focusNode(node.id)}
            onEngineStop={handleEngineStop}
            cooldownTicks={200}
          />
        ) : null}
      </main>
    </div>
  );
}
