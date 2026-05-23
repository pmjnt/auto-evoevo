export function buildFeedDom(memoryButtonCount: number, showMore = false): void {
  document.body.innerHTML = "";
  for (let i = 0; i < memoryButtonCount; i += 1) {
    const article = document.createElement("article");
    const heading = document.createElement("h3");
    heading.textContent = `Card ${i + 1}`;
    const button = document.createElement("button");
    button.textContent = "ADD TO MEMORY";
    article.append(heading, button);
    document.body.append(article);
  }
  if (showMore) {
    const showMoreButton = document.createElement("button");
    showMoreButton.textContent = "SHOW MORE";
    document.body.append(showMoreButton);
  }
}

export function appendMemoryButton(label = "New card"): void {
  const article = document.createElement("article");
  const heading = document.createElement("h3");
  heading.textContent = label;
  const button = document.createElement("button");
  button.textContent = "ADD TO MEMORY";
  article.append(heading, button);
  document.body.append(article);
}
