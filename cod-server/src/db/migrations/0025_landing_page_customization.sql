ALTER TABLE landing_pages ADD COLUMN show_images INTEGER NOT NULL DEFAULT 1;
ALTER TABLE landing_pages ADD COLUMN show_order_form INTEGER NOT NULL DEFAULT 1;
ALTER TABLE landing_pages ADD COLUMN show_sticky_cta INTEGER NOT NULL DEFAULT 1;
ALTER TABLE landing_pages ADD COLUMN background_color TEXT NOT NULL DEFAULT '#ffffff';
ALTER TABLE landing_pages ADD COLUMN button_color TEXT NOT NULL DEFAULT '#7c3aed';
ALTER TABLE landing_pages ADD COLUMN button_text_color TEXT NOT NULL DEFAULT '#ffffff';
ALTER TABLE landing_pages ADD COLUMN button_radius INTEGER NOT NULL DEFAULT 12;
