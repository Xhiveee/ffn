package net.minecraft.server;

import java.util.function.BooleanSupplier;

public abstract class FakeServer extends FakeLoop implements Runnable {
    private int tickCount;
    public static final String NAME = "fake";
    protected final java.util.List<String> names = new java.util.ArrayList<>();

    protected void loadLevel() {
        this.createLevels(3);
        System.out.println("loaded " + NAME);
    }

    protected boolean initServer() {
        return this.tickCount > 0;
    }

    public void tickServer(BooleanSupplier hasTime) {
        ++this.tickCount;
        this.tickChildren(hasTime);
        Runnable r = () -> this.autoSave();
        r.run();
        switch (tickCount % 3) { case 0: autoSave(); break; case 1: tickChildren(hasTime); break; default: break; }
    }

    public void tickChildren(BooleanSupplier hasTime) {}
    private void createLevels(int count) {}
    void autoSave() {}
    public int getTickCount() { return tickCount; }
    public static FakeServer create() { return null; }

    public static class Inner { public long value; }
}
