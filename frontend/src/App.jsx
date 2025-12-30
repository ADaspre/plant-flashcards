import { useEffect, useMemo, useRef, useState } from "react";
import "./app.css";
import { supabase } from "./supabaseClient";
import { runCelebration } from "./celebration";


// ---------- Config ----------
const STORAGE_BUCKET = "plant-images";
const PACK_SIZE = 20;
const INIT_BATCH_SIZE = 100;

const SECTIONS = [
  { key: "floriculture", label: "Floriculture" },
  { key: "arboriculture", label: "Arboriculture" },
];

// ---------- Helpers ----------
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function normalize(s) {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function baseBeforeUnderscore(name) {
  const s = (name ?? "").trim();
  const i = s.indexOf("_");
  return i === -1 ? s : s.slice(0, i);
}

function expectedDisplayName(plantName, section) {
  // Spécifique arboriculture : on ne garde que la 1ère partie avant "_"
  return section === "arboriculture"
    ? baseBeforeUnderscore(plantName)
    : (plantName ?? "").trim();
}


function publicImageUrl(path) {
  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

function sectionStorageKey(userId) {
  return `pf_section_${userId}`;
}

// ---------- App ----------
export default function App() {
  // Auth
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState("");
  const [emailSent, setEmailSent] = useState(false);

  // Section
  const [section, setSection] = useState(null);

  // App state
  const [loading, setLoading] = useState(true);
  const [cardState, setCardState] = useState(null); // { index,total, card:{plantId,name,category,images:[{url,idx}]} }
  const [answer, setAnswer] = useState("");
  const [zoomUrl, setZoomUrl] = useState(null);
  const [celebrating, setCelebrating] = useState(false);

  // App Exam mode
  const [examMode, setExamMode] = useState(false);
  const [examPhase, setExamPhase] = useState("main"); // "main" | "retryWrong"
  const [examQueue, setExamQueue] = useState([]);
  const [examIndex, setExamIndex] = useState(0);
  const [examStateById, setExamStateById] = useState({}); // { [plantId]: "notAsked"|"right"|"wrong" }
  const [examFinished, setExamFinished] = useState(false);


  // feedback: idle | correct | wrong
  const [feedback, setFeedback] = useState("idle");
  const [correctName, setCorrectName] = useState("");

  const inputRef = useRef(null);

  const plantId = cardState?.card?.plantId ?? null;
  const images = cardState?.card?.images ?? [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Overall Progress
  const [sectionProgress, setSectionProgress] = useState(null);

  const progressLabel = useMemo(() => {
    if (!cardState) return "";
    return `${cardState.index + 1} / ${cardState.total}`;
  }, [cardState]);

  const isWrong = feedback === "wrong";
  const isCorrect = feedback === "correct";

  // ---------- Auth bootstrap ----------
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  // ---------- Load persisted section per-user ----------
  useEffect(() => {
    if (!user?.id) {
      setSection(null);
      return;
    }
    const saved = localStorage.getItem(sectionStorageKey(user.id));
    setSection(saved || null);
  }, [user?.id]);

  async function sendMagicLink() {
    const e = email.trim();
    if (!e) return;

    const { error } = await supabase.auth.signInWithOtp({
      email: e,
      options: {
        emailRedirectTo: window.location.href,
      },
    });

    if (error) {
      alert(error.message);
      return;
    }
    setEmailSent(true);
  }

  async function logout() {
    await supabase.auth.signOut();
    setEmailSent(false);
    setEmail("");
    setSection(null);
    setCardState(null);
    setAnswer("");
    setFeedback("idle");
    setCorrectName("");
  }

  function chooseSection(sec) {
    if (!user?.id) return;
    localStorage.setItem(sectionStorageKey(user.id), sec);
    setSection(sec);
  }

  function resetSection() {
    if (!user?.id) return;
    localStorage.removeItem(sectionStorageKey(user.id));
    setSection(null);
    setCardState(null);
    setAnswer("");
    setFeedback("idle");
    setCorrectName("");
  }

  // ---------- Initialization (create plant_state + user_sessions if first time) ----------
  async function ensureUserInitialized(userId) {
    // 1) user_sessions exists ?
    const { data: sess, error: sessErr } = await supabase
      .from("user_sessions")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (sessErr) throw sessErr;

    if (!sess) {
      const { error: insSessErr } = await supabase.from("user_sessions").insert({
        user_id: userId,
        current_queue_json: [],
        current_index: 0,
      });
      if (insSessErr) throw insSessErr;
    }

    // 2) plant_state exists ?
    const { count, error: countErr } = await supabase
      .from("plant_state")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId);

    if (countErr) throw countErr;

    if ((count ?? 0) === 0) {
      // Create one row per plant as notAsked (toutes sections confondues)
      const { data: plants, error: plantsErr } = await supabase
        .from("plants")
        .select("id");

      if (plantsErr) throw plantsErr;

      const rows = plants.map((p) => ({
        user_id: userId,
        plant_id: p.id,
        state: "notAsked",
      }));

      for (let i = 0; i < rows.length; i += INIT_BATCH_SIZE) {
        const batch = rows.slice(i, i + INIT_BATCH_SIZE);
        const { error: insErr } = await supabase.from("plant_state").insert(batch);
        if (insErr) throw insErr;
      }
    }
  }

  // ---------- Session helpers ----------
  async function loadSession(userId) {
    const { data, error } = await supabase
      .from("user_sessions")
      .select("current_queue_json,current_index")
      .eq("user_id", userId)
      .single();

    if (error) throw error;

    return {
      queue: Array.isArray(data.current_queue_json) ? data.current_queue_json : [],
      index: data.current_index ?? 0,
    };
  }

  async function saveSession(userId, queue, index) {
    const { error } = await supabase
      .from("user_sessions")
      .update({
        current_queue_json: queue,
        current_index: index,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);

    if (error) throw error;
  }

  async function setIndex(userId, index) {
    const { error } = await supabase
      .from("user_sessions")
      .update({
        current_index: index,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);

    if (error) throw error;
  }

  // Mode exam helper
  const examTotal = examQueue.length;
  const examRight = useMemo(() => {
    let c = 0;
    for (const k in examStateById) if (examStateById[k] === "right") c++;
    return c;
  }, [examStateById]);

  const examWrong = useMemo(() => {
    let c = 0;
    for (const k in examStateById) if (examStateById[k] === "wrong") c++;
    return c;
  }, [examStateById]);


  // ---------- Queue builder (pending vs new 20) ----------
  async function buildQueueIfNeeded(userId, queue, index, section) {
    if (queue.length > 0 && index < queue.length) {
      return { queue, index, mode: "active" };
    }

    // pending = wrong ∪ inList (dans la section choisie)
    const { data: pendingRows, error: pErr } = await supabase
      .from("plant_state")
      .select("plant_id, plants!inner(section)")
      .eq("user_id", userId)
      .in("state", ["wrong", "inList"])
      .eq("plants.section", section);

    if (pErr) throw pErr;

    if ((pendingRows ?? []).length > 0) {
      const pending = shuffle(pendingRows.map((r) => r.plant_id));
      await saveSession(userId, pending, 0);
      return { queue: pending, index: 0, mode: "review_pending" };
    }

    // else: take up to 20 notAsked (dans la section choisie)
    const { data: naRows, error: naErr } = await supabase
      .from("plant_state")
      .select("plant_id, plants!inner(section)")
      .eq("user_id", userId)
      .eq("state", "notAsked")
      .eq("plants.section", section);

    if (naErr) throw naErr;

    const shuffled = shuffle((naRows ?? []).map((r) => r.plant_id));
    const nextPack = shuffled.slice(0, PACK_SIZE);

    // mark them as inList
    if (nextPack.length > 0) {
      const upserts = nextPack.map((pid) => ({
        user_id: userId,
        plant_id: pid,
        state: "inList",
      }));

      const { error: uErr } = await supabase.from("plant_state").upsert(upserts);
      if (uErr) throw uErr;
    }

    await saveSession(userId, nextPack, 0);
    return { queue: nextPack, index: 0, mode: "learning" };
  }


  // Charge queue for exam mode
  async function startExam() {
    if (!user || !section) return;

    setLoading(true);
    try {
      // Récupérer toutes les plantes de la section
      const { data, error } = await supabase
        .from("plants")
        .select("id")
        .eq("section", section);

      if (error) throw error;

      const ids = shuffle((data ?? []).map((x) => x.id));
      const initState = {};
      ids.forEach((id) => (initState[id] = "notAsked"));

      setExamMode(true);
      setExamPhase("main");
      setExamQueue(ids);
      setExamIndex(0);
      setExamStateById(initState);
      setExamFinished(false);

      // charge la première carte
      const card = await fetchCardPayload(ids[0]);
      if (!card) throw new Error("Impossible de charger la première carte (exam).");

      setCardState({ mode: "exam", index: 0, total: ids.length, card });
      setAnswer("");
      setFeedback("idle");
      setCorrectName("");
      setTimeout(() => inputRef.current?.focus(), 0);
    } catch (e) {
      console.error(e);
      alert(e.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  function exitExamToSectionPicker() {
    setExamMode(false);
    setExamPhase("main");
    setExamQueue([]);
    setExamIndex(0);
    setExamStateById({});
    setExamFinished(false);

    // Retour au choix de section (localStorage)
    resetSection();
  }




  // ---------- Right on total --------------
  async function loadSectionProgress(userId, section) {
    // total plantes dans la section
    const { count: total, error: e1 } = await supabase
      .from("plants")
      .select("*", { count: "exact", head: true })
      .eq("section", section);

    if (e1) throw e1;

    // right pour cet user dans la section
    const { count: right, error: e2 } = await supabase
      .from("plant_state")
      .select("plant_id, plants!inner(section)", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("state", "right")
      .eq("plants.section", section);

    if (e2) throw e2;

    return { right: right ?? 0, total: total ?? 0 };
  }


  // ---------- Card loader ----------
  async function fetchCardPayload(plantId) {
    // Optionnel mais robuste: on s'assure que la plante est bien dans la section choisie
    const { data: p, error: pErr } = await supabase
      .from("plants")
      .select("id,name,category,section")
      .eq("id", plantId)
      .single();

    if (pErr) throw pErr;

    if (section && p.section !== section) {
      // garde-fou : si session corrompue / queue ancienne, on force reload
      return null;
    }

    const { data: imgs, error: iErr } = await supabase
      .from("plant_images")
      .select("path,idx")
      .eq("plant_id", plantId)
      .order("idx", { ascending: true });

    if (iErr) throw iErr;

    const images = imgs.slice(0, 4).map((x) => ({
      idx: x.idx,
      url: publicImageUrl(x.path),
    }));

    return {
      plantId: p.id,
      name: p.name,
      category: p.category,
      images,
    };
  }

  // Load queue
async function loadCard(retry = false) {
  if (!user) return;
  if (!section) return;

  setLoading(true);
  try {
    await ensureUserInitialized(user.id);

    const { queue, index } = await loadSession(user.id);
    const next = await buildQueueIfNeeded(user.id, queue, index, section);

    if (next.queue.length === 0) {
      if (retry) {
        // Fallback si jamais reset impossible (RLS, réseau)
        setCardState({
          index: 0,
          total: 0,
          card: { plantId: null, name: "", category: "", images: [] },
          mode: "done",
        });
        return;
      }

      // 1) Animation premium
      setCelebrating(true);
      runCelebration();

      // 2) Laisse le temps à l’animation d’être ressentie
      await sleep(1800);

      // 3) Reset DB + session
      await resetSectionProgressToNotAsked(user.id, section);

      // 4) Reset UI progress immédiat (optimiste)
      setSectionProgress((p) => (p ? { ...p, right: 0 } : p));

      // 5) Stop overlay
      setCelebrating(false);

      // 6) Relance une seule fois
      await loadCard(true);
      return;
    }

    const currentPlantId = next.queue[next.index];
    const card = await fetchCardPayload(currentPlantId);

    if (!card) {
      await saveSession(user.id, [], 0);
      await loadCard(true);
      return;
    }

    setCardState({
      mode: next.mode,
      index: next.index,
      total: next.queue.length,
      card,
    });

    setAnswer("");
    setFeedback("idle");
    setCorrectName("");

    setTimeout(() => inputRef.current?.focus(), 0);
  } catch (e) {
    console.error(e);
    alert(e.message ?? String(e));
  } finally {
    setLoading(false);
  }
}


  // load overall Progress
  useEffect(() => {
    if (!user || !section) return;

    loadSectionProgress(user.id, section)
      .then(setSectionProgress)
      .catch(console.error);
  }, [user?.id, section]);


  // load once logged in + section selected
  useEffect(() => {
    if (user?.id && section) loadCard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, section]);

  // Once all cards a right
  async function resetSectionProgressToNotAsked(userId, section) {
    // 1) Récupérer tous les plant_id de la section
    const { data: plants, error: pErr } = await supabase
      .from("plants")
      .select("id")
      .eq("section", section);

    if (pErr) throw pErr;

    const ids = (plants ?? []).map((x) => x.id);
    if (ids.length === 0) return;

    // 2) Reset plant_state -> notAsked (par batch pour éviter payload trop gros)
    const BATCH = 200;

    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);

      const { error: uErr } = await supabase
        .from("plant_state")
        .update({ state: "notAsked" })
        .eq("user_id", userId)
        .in("plant_id", chunk);

      if (uErr) throw uErr;
    }

    // 3) Reset session queue/index (sinon tu gardes une queue morte)
    await saveSession(userId, [], 0);
  }


  // ---------- Actions ----------
  async function goNext() {
    if (!user) return;
    const { queue, index } = await loadSession(user.id);
    await setIndex(user.id, index + 1);
    await loadCard();
  }

  // Exam mode next
  async function examNext() {
    const nextIndex = examIndex + 1;

    // Fin de la queue actuelle
    if (nextIndex >= examQueue.length) {
      // Fin de phase
      setExamFinished(true);
      return;
    }

    setExamIndex(nextIndex);

    const nextPlantId = examQueue[nextIndex];
    const card = await fetchCardPayload(nextPlantId);

    if (!card) {
      // si carte introuvable, on saute
      setExamIndex((i) => i + 1);
      return;
    }

    setCardState({
      mode: "exam",
      index: nextIndex,
      total: examQueue.length,
      card,
    });

    setAnswer("");
    setFeedback("idle");
    setCorrectName("");
    setTimeout(() => inputRef.current?.focus(), 0);
  }


  // Retry wrong on exam mode
  async function retryWrongOnly() {
    // construire queue = toutes les wrong (de la section)
    const wrongIds = examQueue.filter((id) => examStateById[id] === "wrong");

    if (wrongIds.length === 0) {
      // tout right -> sortie
      exitExamToSectionPicker();
      return;
    }

    setExamPhase("retryWrong");
    setExamQueue(wrongIds);
    setExamIndex(0);
    setExamFinished(false);

    const card = await fetchCardPayload(wrongIds[0]);
    if (!card) {
      exitExamToSectionPicker();
      return;
    }

    setCardState({ mode: "exam", index: 0, total: wrongIds.length, card });
    setAnswer("");
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  //No retry on wrong during exam mode
  function finishExamNoRetry() {
    exitExamToSectionPicker();
  }


  async function handleSkip() {
    if (!user || !plantId) return;
    if (isWrong || isCorrect) return;

    if (examMode) {
      await examNext(); // pas de changement d'état local
      return;
    }
    await goNext();
  }

  async function handleValidate() {
    if (!user || !plantId) return;
    if (isWrong || isCorrect) return;

    const expected = expectedDisplayName(cardState.card.name, section);
    const correct = normalize(answer) === normalize(expected);

    // ----- MODE EXAMEN (local only) -----
    if (examMode) {
      const expected = expectedDisplayName(cardState.card.name, section);
      const correct = normalize(answer) === normalize(expected);

      setExamStateById((prev) => ({
        ...prev,
        [plantId]: correct ? "right" : "wrong",
      }));

      // pas de feedback visible
      // passer à la carte suivante
      await examNext();
      return;
    }

    // ----- MODE NORMAL (DB) -----
    if (correct) {
      const { error } = await supabase.from("plant_state").upsert({
        user_id: user.id,
        plant_id: plantId,
        state: "right",
      });
      if (error) {
        alert(error.message);
        return;
      }

      setFeedback("correct");

      // Update overAll progress
      setSectionProgress((p) =>
        p ? { ...p, right: p.right + 1 } : p
      );

      setTimeout(async () => {
        await goNext();
      }, 1000);
    } else {
      const { error } = await supabase.from("plant_state").upsert({
        user_id: user.id,
        plant_id: plantId,
        state: "wrong",
      });
      if (error) {
        alert(error.message);
        return;
      }

      setFeedback("wrong");
      setCorrectName(expected);
      setAnswer(expected);
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleValidate();
    }
  }

  function closeZoomIfOverlayClick(e) {
    if (e.target?.dataset?.role === "zoom-overlay") {
      setZoomUrl(null);
    }
  }

  // ---------- UI ----------
  const sectionLabel =
    SECTIONS.find((s) => s.key === section)?.label ?? section ?? "";

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">Plant Flashcards</div>

        <div className="right">
          {user ? (
            <>
              <div className="chip">{user.email}</div>
              {section ? <div className="chip">Section: {sectionLabel}</div> : null}
              {cardState?.total ? <div className="chip">{progressLabel}</div> : null}
              {sectionProgress && section ? (<div className="chip"> Progress: {sectionProgress.right} / {sectionProgress.total}</div>) : null}
              {user && section && !examMode ? (<button className="btn ghost" onClick={startExam} title="Mode examen">Mode examen</button>) : null}
              {examMode ? (<button className="btn ghost" onClick={exitExamToSectionPicker} title="Quitter">Quitter examen</button>) : null}
              {section ? (
                <button className="btn ghost" onClick={resetSection} title="Changer de section">
                  Changer section
                </button>
              ) : null}
              <button className="btn ghost" onClick={logout}>
                Logout
              </button>
            </>
          ) : null}
        </div>
      </header>

      {!user ? (
        <div className="center">
          <div className="card loginCard">
            <h2>Connexion</h2>

            {!emailSent ? (
              <>
                <p>Entre ton email. Tu recevras un lien de connexion (magic link).</p>
                <div className="row">
                  <input
                    className="input"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="email@example.com"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") sendMagicLink();
                    }}
                  />
                  <button className="btn primary" onClick={sendMagicLink}>
                    Envoyer
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>Lien envoyé. Ouvre ton email et clique sur le lien.</p>
                <button className="btn ghost" onClick={() => setEmailSent(false)}>
                  Renvoyer
                </button>
              </>
            )}
          </div>
        </div>
      ) : !section ? (
        // ---------- Section picker ----------
        <div className="center">
          <div className="card loginCard">
            <h2>Choisir une section</h2>
            <p>Choissis ton cours.</p>

            <div className="sectionGrid">
              {SECTIONS.map((s) => (
                <button
                  key={s.key}
                  className="btn sectionBtn"
                  onClick={() => chooseSection(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : loading || !cardState ? (
        <div className="center">
          <div className="card">Chargement...</div>
        </div>
      ) : examMode && examFinished ? (
        <div className="center">
          <div className="card">
            <h2>Résultat examen</h2>
            <p>Score : {examRight} / {examTotal}</p>
            <p>Wrong : {examWrong}</p>

            <div className="row">
              <button className="btn primary" onClick={retryWrongOnly}>
                Refaire uniquement les wrong
              </button>
              <button className="btn ghost" onClick={finishExamNoRetry}>
                Terminer
              </button>
            </div>
          </div>
        </div>
      ) : cardState.mode === "done" ? (
        <div className="center">
          <div className="card">
            <h2>Fin de section</h2>
            <p>Impossible de relancer automatiquement. Change de section ou réessaie.</p>
            <div className="row">
              <button onClick={loadCard}>
                  RESET
              </button>
              <button className="btn ghost" onClick={resetSection}>
                Changer de section
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="center">
          <div
            className={[
              "card",
              "flashcard",
              isCorrect ? "ok" : "",
              isWrong ? "ko" : "",
            ].join(" ")}
          >
            <div className="grid">
              {images.slice(0, 4).map((img) => (
                <button
                  key={img.idx}
                  className="imgBtn"
                  onClick={() => setZoomUrl(img.url)}
                  title="Zoom"
                >
                  <img className="img" src={img.url} alt="plant" />
                </button>
              ))}
            </div>

            <div className="controls">
              <input
                ref={inputRef}
                className="input"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder="Nom de la plante..."
                onKeyDown={onKeyDown}
                disabled={isWrong || isCorrect}
              />

              {isWrong ? (
                <button className="btn nextArrowInline" onClick={goNext} title="Next">
                  →
                </button>
              ) : (
                <>
                  <button
                    className="btn primary vbtn"
                    onClick={handleValidate}
                    disabled={isCorrect}
                    title="Valider (Enter)"
                  >
                    V
                  </button>

                  {!examMode ? (<button className="btn ghost" onClick={handleSkip} disabled={isCorrect}>Skip</button>) : null}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {celebrating ? (
        <div className="celebrateOverlay" aria-hidden="true">
          <div className="celebratePanel">
            <div className="celebrateTitle">Section complétée</div>
            <div className="celebrateKpi">
              {sectionProgress ? `${sectionProgress.right} / ${sectionProgress.total}` : ""}
            </div>
            <div className="celebrateHint">Reset automatique et nouveau cycle…</div>
          </div>
        </div>
      ) : null}



      {zoomUrl ? (
        <div
          className="zoomOverlay"
          data-role="zoom-overlay"
          onClick={closeZoomIfOverlayClick}
        >
          <img className="zoomImage" src={zoomUrl} alt="zoom" />
        </div>
      ) : null}
    </div>
  );
}
