import { useEffect, useMemo, useRef, useState } from "react";
import "./app.css";
import { supabase } from "./supabaseClient";

// ---------- Config ----------
const STORAGE_BUCKET = "plant-images";
const PACK_SIZE = 20;
const INIT_BATCH_SIZE = 100;

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
  return (s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function publicImageUrl(path) {
  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

// ---------- App ----------
export default function App() {
  // Auth
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState("");
  const [emailSent, setEmailSent] = useState(false);

  // App state
  const [loading, setLoading] = useState(true);
  const [cardState, setCardState] = useState(null); // { index,total, card:{plantId,name,category,images:[{url,idx}]} }
  const [answer, setAnswer] = useState("");
  const [zoomUrl, setZoomUrl] = useState(null);

  // feedback: idle | correct | wrong
  const [feedback, setFeedback] = useState("idle");
  const [correctName, setCorrectName] = useState("");

  const inputRef = useRef(null);

  const plantId = cardState?.card?.plantId ?? null;
  const images = cardState?.card?.images ?? [];

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

  async function sendMagicLink() {
    const e = email.trim();
    if (!e) return;

    const { error } = await supabase.auth.signInWithOtp({ email: e });
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
      // create empty session row
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
      // Need to create one row per plant as notAsked
      const { data: plants, error: plantsErr } = await supabase
        .from("plants")
        .select("id");

      if (plantsErr) throw plantsErr;

      const rows = plants.map((p) => ({
        user_id: userId,
        plant_id: p.id,
        state: "notAsked",
      }));

      // Insert in batches
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

  // ---------- Queue builder (pending vs new 20) ----------
  async function buildQueueIfNeeded(userId, queue, index) {
    if (queue.length > 0 && index < queue.length) {
      return { queue, index, mode: "active" };
    }

    // pending = wrong ∪ inList  (=> wrong + skipped come back together)
    const { data: pendingRows, error: pErr } = await supabase
      .from("plant_state")
      .select("plant_id")
      .eq("user_id", userId)
      .in("state", ["wrong", "inList"]);

    if (pErr) throw pErr;

    if (pendingRows.length > 0) {
      const pending = shuffle(pendingRows.map((r) => r.plant_id));
      await saveSession(userId, pending, 0);
      return { queue: pending, index: 0, mode: "review_pending" };
    }

    // else: take up to 20 notAsked
    const { data: naRows, error: naErr } = await supabase
      .from("plant_state")
      .select("plant_id")
      .eq("user_id", userId)
      .eq("state", "notAsked");

    if (naErr) throw naErr;

    const shuffled = shuffle(naRows.map((r) => r.plant_id));
    const nextPack = shuffled.slice(0, PACK_SIZE);

    // mark them as inList
    if (nextPack.length > 0) {
      const upserts = nextPack.map((pid) => ({
        user_id: userId,
        plant_id: pid,
        state: "inList",
      }));

      // upsert by (user_id, plant_id) primary key
      const { error: uErr } = await supabase.from("plant_state").upsert(upserts);
      if (uErr) throw uErr;
    }

    await saveSession(userId, nextPack, 0);
    return { queue: nextPack, index: 0, mode: "learning" };
  }

  // ---------- Card loader ----------
  async function fetchCardPayload(plantId) {
    const { data: p, error: pErr } = await supabase
      .from("plants")
      .select("id,name,category")
      .eq("id", plantId)
      .single();

    if (pErr) throw pErr;

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

  async function loadCard() {
    if (!user) return;

    setLoading(true);
    try {
      await ensureUserInitialized(user.id);

      const { queue, index } = await loadSession(user.id);
      const next = await buildQueueIfNeeded(user.id, queue, index);

      if (next.queue.length === 0) {
        // plus rien à apprendre (tout right)
        setCardState({
          index: 0,
          total: 0,
          card: { plantId: null, name: "", category: "", images: [] },
          mode: "done",
        });
        setAnswer("");
        setFeedback("idle");
        setCorrectName("");
        return;
      }

      const currentPlantId = next.queue[next.index];
      const card = await fetchCardPayload(currentPlantId);

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

  // initial load once logged in
  useEffect(() => {
    if (user) loadCard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // ---------- Actions ----------
  async function goNext() {
    if (!user) return;
    const { queue, index } = await loadSession(user.id);
    await setIndex(user.id, index + 1);
    await loadCard();
  }

  async function handleSkip() {
    if (!user || !plantId) return;
    if (isWrong || isCorrect) return;

    // Skip does NOT change state (remains inList), just advances index
    await goNext();
  }

  async function handleValidate() {
    if (!user || !plantId) return;
    if (isWrong || isCorrect) return;

    const correct = normalize(answer) === normalize(cardState.card.name);

    if (correct) {
      // set right
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

      setTimeout(async () => {
        await goNext();
      }, 1000);
    } else {
      // set wrong
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
      setCorrectName(cardState.card.name);
      setAnswer(cardState.card.name); // remplis la bonne réponse
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleValidate();
    }
  }

  // Zoom overlay close rule: click overlay but not image
  function closeZoomIfOverlayClick(e) {
    if (e.target?.dataset?.role === "zoom-overlay") {
      setZoomUrl(null);
    }
  }

  // ---------- UI ----------
  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">Plant Flashcards</div>

        <div className="right">
          {user ? (
            <>
              <div className="chip">{user.email}</div>
              {cardState?.total ? <div className="chip">{progressLabel}</div> : null}
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
      ) : loading || !cardState ? (
        <div className="center">
          <div className="card">Chargement...</div>
        </div>
      ) : cardState.mode === "done" ? (
        <div className="center">
          <div className="card">
            <h2>Terminé</h2>
            <p>Plus de cartes disponibles (tout est en right).</p>
            <button className="btn ghost" onClick={loadCard}>
              Recharger
            </button>
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

                  <button className="btn ghost" onClick={handleSkip} disabled={isCorrect}>
                    Skip
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

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
