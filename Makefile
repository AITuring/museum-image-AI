.PHONY: quick-entry identify

# Fast path: starts the EXIF workbench only; its final upload goes straight to cloud.
quick-entry:
	npm --prefix frontend run dev:quick

# Smart path: starts the local API, databases, browser bridge, and identify UI.
identify:
	docker compose up --build
