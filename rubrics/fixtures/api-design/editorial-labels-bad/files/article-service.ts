import { parseArticleCategory } from './article-categories';
import type { ArticleRepository, StoredArticle } from './article-repository';

export async function publishArticle(
  repository: ArticleRepository,
  input: { readonly id: string; readonly title: string; readonly bodyMarkdown: string; readonly category: string },
): Promise<StoredArticle> {
  const article: StoredArticle = {
    id: input.id,
    title: input.title.trim(),
    bodyMarkdown: input.bodyMarkdown,
    category: parseArticleCategory(input.category),
  };
  await repository.save(article);
  return article;
}
