import { ApiEndpoint, type LeaderboardResponse } from "../shared/api.ts";

const list = document.getElementById("leaderboard") as HTMLOListElement;

const RANK_LABELS = ["🥇", "🥈", "🥉"];
const RANK_CLASSES = ["gold", "silver", "bronze"];

async function fetchLeaderboard() {
  try {
    const response = await fetch(ApiEndpoint.Leaderboard);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as LeaderboardResponse;

    list.innerHTML = "";

    if (data.entries.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No mentions yet. Say Kruk!";
      list.appendChild(li);
      return;
    }

    data.entries.forEach((entry, i) => {
      const li = document.createElement("li");

      const rank = document.createElement("span");
      rank.className = `rank${i < 3 ? ` ${RANK_CLASSES[i]}` : ""}`;
      rank.textContent = i < 3 ? (RANK_LABELS[i] ?? `${i + 1}`) : `${i + 1}`;

      const username = document.createElement("span");
      username.className = "username";
      username.textContent = `u/${entry.username}`;

      const score = document.createElement("span");
      score.className = "score";
      score.textContent = `${entry.score} ${entry.score === 1 ? "mention" : "mentions"}`;

      li.appendChild(rank);
      li.appendChild(username);
      li.appendChild(score);
      list.appendChild(li);
    });
  } catch (err) {
    list.innerHTML = `<li class="empty">Failed to load leaderboard.</li>`;
    console.error("Leaderboard fetch error:", err);
  }
}

fetchLeaderboard();
