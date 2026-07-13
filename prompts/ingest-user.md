Ingest the document into {{document_dir}}.

Title: {{title}}
Source file: {{source_file}}
Page count: {{page_count}}
Extracted images: {{image_count}}

Start by calling get_source_metadata, then create markdown chunks of at most 2 pages each until finished.
For every chunk, set topic_slug to a kebab-case phrase naming the concrete subjects on those pages.
Write pure Markdown only: never use HTML tags such as <br>, <p>, <div>, or <table>. For multi-value table cells, join with " · " instead of <br>.
