import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { analyzeBettingImage } from "@/lib/analyze.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast, Toaster } from "sonner";
import {
  Upload, Trophy, TrendingUp, Target, Zap, Loader2, FileDown, Trash2, Filter,
} from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell,
} from "recharts";
import jsPDF from "jspdf";

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "BetAnalyzer Pro — Football Betting Analysis" },
      {
        name: "description",
        content:
          "Upload betting odds screenshots and get AI-powered goal predictions, confidence scores and bet recommendations.",
      },
      { property: "og:title", content: "BetAnalyzer Pro" },
      { property: "og:description", content: "AI football betting odds analyzer with goal predictions." },
    ],
  }),
});

type RawMatch = {
  homeTeam: string;
  awayTeam: string;
  odd1: number;
  oddX: number;
  odd2: number;
};

type AnalyzedMatch = RawMatch & {
  id: string;
  createdAt: number;
  minOdd: number;
  predictedGoals: 1 | 3 | 5 | "X";
  predictedOutcome: "1" | "X" | "2";
  confidence: number;
  confidenceLabel: "Low" | "Medium" | "High";
  recommendation: "green" | "orange" | "red";
  prob1: number;
  probX: number;
  prob2: number;
  margin: number;
  expectedGoals: number;
  bttsProb: number;
  over25Prob: number;
  under25Prob: number;
};

const STORAGE_KEY = "betanalyzer.history.v2";

function poisson(k: number, lambda: number) {
  let f = 1;
  for (let i = 2; i <= k; i++) f *= i;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / f;
}

function classifyMatch(m: RawMatch): AnalyzedMatch {
  const minOdd = Math.min(m.odd1, m.odd2);

  const raw1 = 1 / m.odd1;
  const rawX = 1 / m.oddX;
  const raw2 = 1 / m.odd2;
  const overround = raw1 + rawX + raw2;
  const margin = (overround - 1) * 100;

  // Normalize implied probabilities by removing bookmaker margin
  const prob1 = (raw1 / overround) * 100;
  const probX = (rawX / overround) * 100;
  const prob2 = (raw2 / overround) * 100;

  let predictedGoals: AnalyzedMatch["predictedGoals"];
  if (m.odd1 >= 2.4 && m.odd1 <= 2.7 && m.odd2 >= 2.4 && m.odd2 <= 2.7) {
    predictedGoals = "X";
  } else if (minOdd < 1.5) predictedGoals = 3;
  else if (minOdd <= 2.3) predictedGoals = 1;
  else predictedGoals = 5;

  const predictedOutcome: AnalyzedMatch["predictedOutcome"] =
    prob1 >= probX && prob1 >= prob2 ? "1" : prob2 >= probX ? "2" : "X";

  // Expected total goals from draw odd (calibrated empirical mapping)
  const expectedGoals = Math.max(1.5, Math.min(3.8, 0.7 * m.oddX + 0.4));

  // Split goals between teams using normalized win probabilities
  const strength1 = prob1 / Math.max(0.001, prob1 + prob2);
  const lambdaH = expectedGoals * strength1;
  const lambdaA = expectedGoals * (1 - strength1);

  const bttsProb = (1 - Math.exp(-lambdaH)) * (1 - Math.exp(-lambdaA)) * 100;

  let under = 0;
  for (let a = 0; a <= 2; a++) {
    for (let b = 0; b <= 2 - a; b++) {
      under += poisson(a, lambdaH) * poisson(b, lambdaA);
    }
  }
  const under25Prob = under * 100;
  const over25Prob = 100 - under25Prob;

  // Confidence combines top probability, gap to runner-up, and margin penalty
  const sorted = [prob1, probX, prob2].sort((a, b) => b - a);
  const gap = sorted[0] - sorted[1];
  const rawConf = sorted[0] + gap * 0.4 - margin * 0.5;
  const confidence = Math.round(Math.min(95, Math.max(15, rawConf)));
  const confidenceLabel: AnalyzedMatch["confidenceLabel"] =
    confidence >= 70 ? "High" : confidence >= 50 ? "Medium" : "Low";
  const recommendation: AnalyzedMatch["recommendation"] =
    confidence >= 70 ? "green" : confidence >= 50 ? "orange" : "red";

  return {
    ...m,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    minOdd,
    predictedGoals,
    predictedOutcome,
    confidence,
    confidenceLabel,
    recommendation,
    prob1,
    probX,
    prob2,
    margin,
    expectedGoals,
    bttsProb,
    over25Prob,
    under25Prob,
  };
}

function recColors(r: AnalyzedMatch["recommendation"]) {
  if (r === "green") return "text-success border-success/40 bg-success/10";
  if (r === "orange") return "text-warning border-warning/40 bg-warning/10";
  return "text-destructive border-destructive/40 bg-destructive/10";
}

function goalsColor(g: AnalyzedMatch["predictedGoals"]) {
  if (g === 3) return "bg-success text-success-foreground";
  if (g === 1) return "bg-warning text-warning-foreground";
  if (g === 5) return "bg-destructive text-destructive-foreground";
  return "bg-secondary text-secondary-foreground";
}

function Index() {
  const analyze = useServerFn(analyzeBettingImage);
  const [matches, setMatches] = useState<AnalyzedMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<"all" | "1" | "3" | "5" | "X">("all");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setMatches(JSON.parse(raw));
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(matches));
    } catch {}
  }, [matches]);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setLoading(true);
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue;
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result as string);
          r.onerror = reject;
          r.readAsDataURL(file);
        });
        const result = await analyze({ data: { imageDataUrl: dataUrl } });
        const analyzed = (result.matches ?? []).map(classifyMatch);
        if (analyzed.length === 0) {
          toast.warning(`No matches found in ${file.name}`);
        } else {
          setMatches((prev) => [...analyzed, ...prev]);
          toast.success(`Extracted ${analyzed.length} match${analyzed.length > 1 ? "es" : ""}`);
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Analysis failed");
    } finally {
      setLoading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const filtered = useMemo(() => {
    if (filter === "all") return matches;
    return matches.filter((m) => String(m.predictedGoals) === filter);
  }, [matches, filter]);

  const stats = useMemo(() => {
    const total = matches.length;
    const avgConf = total ? Math.round(matches.reduce((s, m) => s + m.confidence, 0) / total) : 0;
    const high = matches.filter((m) => m.confidenceLabel === "High").length;
    return { total, avgConf, high };
  }, [matches]);

  const chartData = useMemo(
    () =>
      filtered.slice(0, 10).map((m) => ({
        name: `${m.homeTeam.slice(0, 6)} v ${m.awayTeam.slice(0, 6)}`,
        confidence: m.confidence,
        rec: m.recommendation,
      })),
    [filtered],
  );

  const exportPDF = () => {
    if (matches.length === 0) {
      toast.error("Nothing to export");
      return;
    }
    const doc = new jsPDF();
    doc.setFontSize(18);
    doc.text("BetAnalyzer Pro — Analysis Report", 14, 18);
    doc.setFontSize(10);
    doc.text(new Date().toLocaleString(), 14, 25);
    let y = 35;
    matches.forEach((m, i) => {
      if (y > 270) {
        doc.addPage();
        y = 20;
      }
      doc.setFontSize(12);
      doc.text(`${i + 1}. ${m.homeTeam} vs ${m.awayTeam}`, 14, y);
      y += 6;
      doc.setFontSize(10);
      doc.text(
        `1: ${m.odd1.toFixed(2)}   X: ${m.oddX.toFixed(2)}   2: ${m.odd2.toFixed(2)}   |  Goals: ${m.predictedGoals}  |  Confidence: ${m.confidence}% (${m.confidenceLabel})`,
        14,
        y,
      );
      y += 10;
    });
    doc.save("betanalyzer-report.pdf");
  };

  return (
    <div className="min-h-screen">
      <Toaster theme="dark" position="top-center" richColors />

      {/* Header */}
      <header className="border-b border-border/60 backdrop-blur bg-background/60 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-primary text-primary-foreground grid place-items-center shadow-lg shadow-primary/30">
              <Trophy className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">BetAnalyzer Pro</h1>
              <p className="text-xs text-muted-foreground">AI football odds analyzer</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={exportPDF} className="gap-2">
            <FileDown className="h-4 w-4" />
            <span className="hidden sm:inline">Export PDF</span>
          </Button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* Upload */}
        <Card className="border-dashed border-primary/40 bg-card/60">
          <CardContent className="p-6">
            <label
              htmlFor="file-upload"
              className="flex flex-col items-center justify-center gap-3 cursor-pointer py-6"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                handleFiles(e.dataTransfer.files);
              }}
            >
              <div className="h-14 w-14 rounded-full bg-primary/15 text-primary grid place-items-center">
                {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : <Upload className="h-6 w-6" />}
              </div>
              <div className="text-center">
                <p className="font-semibold">
                  {loading ? "Analyzing image with AI…" : "Upload betting odds screenshot"}
                </p>
                <p className="text-sm text-muted-foreground">JPG or PNG · drop or click to browse</p>
              </div>
              <input
                ref={fileRef}
                id="file-upload"
                type="file"
                accept="image/png,image/jpeg"
                multiple
                className="hidden"
                onChange={(e) => handleFiles(e.target.files)}
                disabled={loading}
              />
            </label>
          </CardContent>
        </Card>

        {/* Summary */}
        <div className="grid grid-cols-3 gap-3">
          <StatCard icon={<Target className="h-4 w-4" />} label="Matches" value={stats.total} />
          <StatCard icon={<TrendingUp className="h-4 w-4" />} label="Avg confidence" value={`${stats.avgConf}%`} />
          <StatCard icon={<Zap className="h-4 w-4" />} label="High confidence" value={stats.high} />
        </div>

        {/* Filter */}
        {matches.length > 0 && (
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Filter className="h-4 w-4" /> Predicted goals
            </div>
            <Tabs value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
              <TabsList>
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="1">1</TabsTrigger>
                <TabsTrigger value="3">3</TabsTrigger>
                <TabsTrigger value="5">5</TabsTrigger>
                <TabsTrigger value="X">X</TabsTrigger>
              </TabsList>
            </Tabs>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto text-muted-foreground hover:text-destructive gap-2"
              onClick={() => {
                setMatches([]);
                toast.success("History cleared");
              }}
            >
              <Trash2 className="h-4 w-4" />
              Clear
            </Button>
          </div>
        )}

        {/* Chart */}
        {filtered.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Confidence overview</CardTitle>
            </CardHeader>
            <CardContent className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="name" tick={{ fill: "var(--muted-foreground)", fontSize: 10 }} />
                  <YAxis domain={[0, 100]} tick={{ fill: "var(--muted-foreground)", fontSize: 10 }} />
                  <Tooltip
                    cursor={{ fill: "var(--accent)", opacity: 0.3 }}
                    contentStyle={{
                      background: "var(--popover)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      color: "var(--foreground)",
                    }}
                  />
                  <Bar dataKey="confidence" radius={[6, 6, 0, 0]}>
                    {chartData.map((d, i) => (
                      <Cell
                        key={i}
                        fill={
                          d.rec === "green"
                            ? "var(--success)"
                            : d.rec === "orange"
                              ? "var(--warning)"
                              : "var(--destructive)"
                        }
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}

        {/* Matches grid */}
        {filtered.length > 0 ? (
          <div className="grid sm:grid-cols-2 gap-4">
            {filtered.map((m) => (
              <MatchCard key={m.id} match={m} />
            ))}
          </div>
        ) : (
          matches.length === 0 && (
            <div className="text-center text-muted-foreground py-12 text-sm">
              Upload a screenshot to extract matches and generate predictions.
            </div>
          )
        )}
      </main>

      <footer className="text-center text-xs text-muted-foreground py-8">
        BetAnalyzer Pro · for entertainment only · gamble responsibly
      </footer>
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <Card className="bg-card/70">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          {icon}
          {label}
        </div>
        <div className="text-2xl font-bold mt-1">{value}</div>
      </CardContent>
    </Card>
  );
}

function MatchCard({ match: m }: { match: AnalyzedMatch }) {
  return (
    <Card className="overflow-hidden">
      <div className={`h-1 ${m.recommendation === "green" ? "bg-success" : m.recommendation === "orange" ? "bg-warning" : "bg-destructive"}`} />
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="font-semibold leading-tight">
            <span>{m.homeTeam}</span>
            <span className="text-muted-foreground mx-2">vs</span>
            <span>{m.awayTeam}</span>
          </div>
          <Badge className={`${goalsColor(m.predictedGoals)} font-bold`}>
            {m.predictedGoals === "X" ? "Draw" : `${m.predictedGoals} goals`}
          </Badge>
        </div>

        <div className="grid grid-cols-3 gap-2 text-center">
          <OddBox label="1" odd={m.odd1} prob={m.prob1} />
          <OddBox label="X" odd={m.oddX} prob={m.probX} />
          <OddBox label="2" odd={m.odd2} prob={m.prob2} />
        </div>

        <div>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-muted-foreground">Confidence</span>
            <span className={`font-semibold ${recColors(m.recommendation).split(" ")[0]}`}>
              {m.confidence}% · {m.confidenceLabel}
            </span>
          </div>
          <Progress value={m.confidence} className="h-2" />
        </div>
      </CardContent>
    </Card>
  );
}

function OddBox({ label, odd, prob }: { label: string; odd: number; prob: number }) {
  return (
    <div className="rounded-lg bg-secondary/60 border border-border p-2">
      <div className="text-[10px] text-muted-foreground font-semibold">{label}</div>
      <div className="font-bold">{odd.toFixed(2)}</div>
      <div className="text-[10px] text-muted-foreground">{prob.toFixed(0)}%</div>
    </div>
  );
}
