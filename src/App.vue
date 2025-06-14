<template>
  <div id="app">
    <Layout ref="layout" />
  </div>
</template>

<script>
import util from "@/libs/util";
import Layout from "./views/Layout";

export default {
  name: "App",
  components: {
    Layout,
  },
  watch: {
    "$i18n.locale": "i18nHandle",
  },
  created() {
    this.i18nHandle(this.$i18n.locale);
  },
  mounted() {
    // this.checkVersion(); // 已禁用版本检查
  },
  methods: {
    i18nHandle(val) {
      util.cookies.set("lang", val);
      document.querySelector("html").setAttribute("lang", val);
    },
  },
};
</script>

