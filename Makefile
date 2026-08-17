.PHONY: quick-entry identify

# Fast path: only starts the small Vite page and sends uploads to the cloud API.
quick-entry:
	npm --prefix frontend run dev:quick

# Smart path: starts the local API, databases, browser bridge, and identify UI.
identify:
	docker compose up --build
